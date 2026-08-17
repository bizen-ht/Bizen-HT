/* ====================================
   BIZEN HT — Stories des Elus (interactions)
   Une Elu poste des stories (texte+emoji OU photo+caption). Les VIP les voient.
   Vues / likes / commentaires passent par le serveur (Admin SDK) car un VIP ne
   peut pas écrire le doc story d'une Elu (règles).

   Actions :
   - view    : enregistre une vue (dédupliquée par viewer) → viewCount.
   - like    : bascule le like (likedBy) → likeCount.
   - comment : VIP PREMIUM seulement → envoie un MESSAGE PRIVÉ à l'Elu (fil DM,
               référencé à la story) + incrémente commentCount. Emojis permis,
               coordonnées (tel/WhatsApp/email) masquées.
   ==================================== */
const admin = require('firebase-admin');

var _ready = false;
function init() {
    if (!_ready) {
        var raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
        if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT manquant");
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
        }
        _ready = true;
    }
}

var CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};
function ok(b)  { return { statusCode: 200, headers: CORS, body: JSON.stringify(b) }; }
function err(c, m, extra) { return { statusCode: c, headers: CORS, body: JSON.stringify(Object.assign({ error: m }, extra || {})) }; }

var ADMIN_EMAIL = "bizenht@gmail.com";
var STORAGE_BUCKET = "bizen-ht.firebasestorage.app";
var STORY_TTL_MS = 24 * 3600 * 1000;   /* estòri éphémère 24h */

/* Supprime la photo d'une story dans Firebase Storage (best effort). */
async function deleteStoryPhoto(story) {
    if (!story || story.type !== "photo" || !story.storagePath) return;
    try { await admin.storage().bucket(STORAGE_BUCKET).file(story.storagePath).delete(); }
    catch (e) { console.warn("[STORY] delete photo:", e.message); }
}

/* Masque les coordonnées externes (emojis non touchés). */
function filterContact(text) {
    var t = String(text == null ? "" : text);
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, "•••");
    t = t.replace(/(^|[\s.,!?])@\w{2,}/g, "$1•••");
    t = t.replace(/(\+?\d[\d\s().\-]{4,}\d)/g, "•••");
    t = t.replace(/\b(whats?ap?p?|wsp|watsap|telegram|signal|viber|imo|snapchat|snap|instagram|insta|\big\b|tiktok|facebook|\bfb\b|messenger|gmail|hotmail|yahoo|outlook|e?-?mail|imel|nimewo|numero|num[ée]ro)\b/gi, "•••");
    return t;
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        if (!body.idToken) return err(401, "idToken requis");
        var action = (body.action || "").toString();
        var storyId = (body.storyId || "").toString();
        /* storyId requis pour view/like/comment (vérifié après l'action "post"). */

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var now = Date.now();
        var nowTs = admin.firestore.Timestamp.fromMillis(now);

        /* ---------- PUBLIER UNE STORY (Elu) ---------- */
        if (action === "post") {
            var uSnap = await dbf.collection("users").doc(uid).get();
            if (!uSnap.exists) return err(404, "Kont pa jwenn.");
            var u = uSnap.data();
            if (u.type !== "freelancer" && u.type !== "krey") return err(403, "Sèlman Elu ka poste estòri.");
            if (u.status && u.status !== "active") return err(403, "Kont ou poko aktif.");

            var stype = (body.type === "photo") ? "photo" : "text";
            var stext = filterContact((body.text || "").toString().trim().slice(0, 400));
            var photoUrl = (body.photoUrl || "").toString().slice(0, 600);
            var storagePath = (body.storagePath || "").toString().slice(0, 300);
            if (stype === "photo" && photoUrl.indexOf("https://") !== 0) return err(400, "Foto pa valab.");
            if (stype === "text" && !stext) return err(400, "Ekri kichòy.");

            var ref = await dbf.collection("stories").add({
                eluUid: uid,
                eluPseudo: (u.pseudo || u.prenom || "Elu"),
                eluPhotoUrl: (u.photoUrl || ""),
                type: stype,
                text: stext,
                photoUrl: (stype === "photo") ? photoUrl : "",
                storagePath: (stype === "photo") ? storagePath : "",
                viewCount: 0, likeCount: 0, commentCount: 0,
                viewedBy: [], likedBy: [],
                createdAt: nowTs,
                expiresAt: admin.firestore.Timestamp.fromMillis(now + STORY_TTL_MS)   /* éphémère 24h */
            });
            return ok({ success: true, id: ref.id });
        }

        if (!storyId) return err(400, "storyId requis");
        var storyRef = dbf.collection("stories").doc(storyId);
        var storySnap = await storyRef.get();
        if (!storySnap.exists) return err(404, "Estòri pa jwenn.");
        var story = storySnap.data();
        var eluUid = story.eluUid;

        /* ---------- VUE (dédupliquée) ---------- */
        if (action === "view") {
            if (uid === eluUid) return ok({ skipped: "self" });
            if ((story.viewedBy || []).indexOf(uid) !== -1) return ok({ already: true, viewCount: story.viewCount || 0 });
            await storyRef.update({ viewedBy: FieldValue.arrayUnion(uid), viewCount: FieldValue.increment(1) });
            return ok({ success: true, viewCount: (story.viewCount || 0) + 1 });
        }

        /* ---------- LIKE (toggle) ---------- */
        if (action === "like") {
            if (uid === eluUid) return err(400, "Ou pa ka like pwòp estòri ou.");
            var liked = (story.likedBy || []).indexOf(uid) !== -1;
            if (liked) {
                await storyRef.update({ likedBy: FieldValue.arrayRemove(uid), likeCount: FieldValue.increment(-1) });
                return ok({ success: true, liked: false, likeCount: Math.max(0, (story.likeCount || 0) - 1) });
            } else {
                await storyRef.update({ likedBy: FieldValue.arrayUnion(uid), likeCount: FieldValue.increment(1) });
                return ok({ success: true, liked: true, likeCount: (story.likeCount || 0) + 1 });
            }
        }

        /* ---------- COMMENTAIRE = MESSAGE PRIVÉ (VIP Premium) ---------- */
        if (action === "comment") {
            if (uid === eluUid) return err(400, "Ou pa ka komante pwòp estòri ou.");
            var raw = (body.text || "").toString().trim().slice(0, 500);
            if (!raw) return err(400, "Mesaj vid.");

            var vipSnap = await dbf.collection("users").doc(uid).get();
            if (!vipSnap.exists) return err(404, "Kont pa jwenn.");
            var vip = vipSnap.data();
            if (vip.type && vip.type !== "user") return err(403, "Sèlman VIP ka komante.");
            if (vip.isPremium !== true) return err(403, "Se yon fonksyon Premium. Vin Premium pou komante.", { premiumInvite: true });

            var text = filterContact(raw);
            var vipName = vip.pseudo || vip.prenom || "VIP";

            /* Fil DM déterministe : userUid = VIP (initiateur/client), eluUid = Elu. */
            var pair = [uid, eluUid].sort();
            var threadId = pair[0] + "_" + pair[1];
            var threadRef = dbf.collection("dmThreads").doc(threadId);
            var threadSnap = await threadRef.get();
            var thread = threadSnap.exists ? threadSnap.data() : null;
            var isEphemeral = !(thread && thread.ephemeral === false);

            var eluDoc = await dbf.collection("users").doc(eluUid).get();
            var elu = eluDoc.exists ? eluDoc.data() : {};
            var eluName = elu.pseudo || elu.prenom || "Elu";

            var body2 = "💬 Sou estòri ou: " + text;
            var msgDoc = {
                threadId: threadId,
                participants: pair,
                senderId: uid,            /* le VIP envoie */
                receiverId: eluUid,
                text: body2,
                mediaUrl: "", mediaType: "",
                storyId: storyId,
                createdAt: nowTs
            };
            if (isEphemeral) msgDoc.expireAt = admin.firestore.Timestamp.fromMillis(now + 24 * 3600 * 1000);
            await dbf.collection("dmMessages").add(msgDoc);

            var threadUpdate = {
                participants: pair,
                lastMessage: body2.slice(0, 120),
                lastAt: nowTs, updatedAt: nowTs,
                unreadForElu: FieldValue.increment(1),
                userIsPremium: true
            };
            if (!threadSnap.exists) {
                threadUpdate.userUid = uid;
                threadUpdate.eluUid = eluUid;
                threadUpdate.userName = vipName;
                threadUpdate.eluName = eluName;
                threadUpdate.createdAt = nowTs;
            }
            await threadRef.set(threadUpdate, { merge: true });

            await storyRef.update({ commentCount: FieldValue.increment(1) });

            /* Push à l'Elu (best effort). */
            try {
                var tokens = (elu.fcmTokens || []);
                if (tokens.length) {
                    await admin.messaging().sendEachForMulticast({
                        tokens: tokens,
                        notification: { title: vipName + " komante estòri ou 💬", body: text.slice(0, 100) },
                        data: { link: "/Dashboard.html" },
                        webpush: { fcmOptions: { link: "/Dashboard.html" } }
                    });
                }
            } catch (e) { /* ignore */ }

            return ok({ success: true, threadId: threadId });
        }

        /* ---------- SUPPRIMER UNE STORY (Elu propriétaire, ou admin) ---------- */
        if (action === "delete") {
            if (story.eluUid !== uid && decoded.email !== ADMIN_EMAIL) return err(403, "Se pa estòri ou.");
            await deleteStoryPhoto(story);       /* efase foto nan Storage */
            await storyRef.delete();
            return ok({ success: true });
        }

        return err(400, "Aksyon enkoni.");
    } catch (e) {
        console.error("[STORY]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
