/* ====================================
   BIZEN SOCIAL — Messagerie (uniquement APRÈS un match réciproque)
   SEUL moyen d'envoyer un message (anti-triche côté serveur) :
   - vérifie qu'un MATCH existe entre les deux (pas de message sans match)
   - vérifie les limites journalières (gratuit / premium)
   - filtre les contacts externes (repris de dm-send)
   - écrit le message (éphémère selon le réglage du match) + met à jour le match
   Règles freemium :
   - GRATUIT : 20 messages/jour (tous matchs cumulés)
   - PREMIUM : messages illimités
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

function haitiDate() {
    return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/* Masque les coordonnées externes (identique à la messagerie Élu). */
function filterContact(text) {
    var t = String(text == null ? "" : text);
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, "•••");
    t = t.replace(/(^|[\s.,!?])@\w{2,}/g, "$1•••");
    t = t.replace(/(\+?\d[\d\s().\-]{4,}\d)/g, "•••");
    t = t.replace(/\b(whats?ap?p?|wsp|watsap|telegram|signal|viber|imo|snapchat|snap|instagram|insta|\big\b|tiktok|facebook|\bfb\b|messenger|gmail|hotmail|yahoo|outlook|e?-?mail|imel|nimewo|numero|num[ée]ro)\b/gi, "•••");
    return t;
}

var FREE_MSGS_PER_DAY = 20;
/* PHASE 1 = tout gratuit. Mettre false plus tard pour reactiver le freemium. */
var PHASE_ALL_FREE = true;

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var pairId = (body.pairId || "").toString();
        var rawText = (body.text || "").toString();
        var mediaUrl = (body.mediaUrl || "").toString().slice(0, 600);
        var mediaType = (body.mediaType === "image") ? "image" : "";

        if (!idToken) return err(401, "idToken requis");
        if (!pairId) return err(400, "pairId requis");
        if (mediaUrl && mediaUrl.indexOf("https://") !== 0) return err(400, "Medya pa valab.");
        if (!mediaUrl) mediaType = "";
        var text = rawText.trim().slice(0, 1000);
        if (!text && !mediaUrl) return err(400, "Mesaj vid.");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var now = Date.now();
        var nowTs = admin.firestore.Timestamp.fromMillis(now);

        /* Le MATCH doit exister et je dois en faire partie. */
        var matchRef = dbf.collection("socialMatches").doc(pairId);
        var matchSnap = await matchRef.get();
        if (!matchSnap.exists) return err(404, "Pa gen match sa a.");
        var match = matchSnap.data();
        if (!match.users || match.users.indexOf(uid) === -1) return err(403, "Ou pa nan match sa a.");
        var otherUid = match.users[0] === uid ? match.users[1] : match.users[0];

        /* Compte gelé => pas d'envoi. */
        var meSnap = await dbf.collection("socialProfiles").doc(uid).get();
        if (meSnap.exists && meSnap.data().status === "banned") return err(403, "Kont Social ou sispann.");

        /* Un blocage (dans un sens ou l'autre) coupe la messagerie. */
        var blk1 = await dbf.collection("socialBlocks").doc(uid + "_" + otherUid).get();
        var blk2 = await dbf.collection("socialBlocks").doc(otherUid + "_" + uid).get();
        if (blk1.exists || blk2.exists) return err(403, "Konvèsasyon sa a fèmen.");

        /* Premium ? */
        var entSnap = await dbf.collection("socialEntitlements").doc(uid).get();
        var ent = entSnap.exists ? entSnap.data() : {};
        var isPremium = ent.premiumUntil && ent.premiumUntil.toMillis && ent.premiumUntil.toMillis() > now;

        /* ---- LIMITE DE MESSAGES : vérif + réservation ATOMIQUE (gratuit) ---- */
        if (!PHASE_ALL_FREE && !isPremium) {
            var dstr = haitiDate();
            var counterRef = dbf.collection("socialCounters").doc(uid + "_" + dstr);
            var limit;
            try {
                limit = await dbf.runTransaction(async function (t) {
                    var cSnap = await t.get(counterRef);
                    var c = cSnap.exists ? cSnap.data() : {};
                    var used = c.messages || 0;
                    if (used >= FREE_MSGS_PER_DAY) return { blocked: true };
                    t.set(counterRef, { messages: used + 1, date: dstr, updatedAt: nowTs }, { merge: true });
                    return { used: used + 1 };
                });
            } catch (e) {
                console.error("[SOCIAL-MSG] counter tx:", e.message);
                return err(500, "Erè kontè. Eseye ankò.");
            }
            if (limit.blocked) {
                return err(429,
                    "Ou voye " + FREE_MSGS_PER_DAY + " mesaj jodi a (limit gratis la). Vin Premium pou mesaj san limit, oswa tann demen.",
                    { reason: "messages", premiumInvite: true });
            }
        }

        /* ---- ÉCRITURE DU MESSAGE (filtré, éphémère selon le match) ---- */
        var isEphemeral = match.ephemeral !== false;
        var filtered = filterContact(text);
        var msgDoc = {
            pairId: pairId,
            participants: match.users,
            senderId: uid,
            receiverId: otherUid,
            text: filtered,
            mediaUrl: mediaUrl || "",
            mediaType: mediaUrl ? mediaType : "",
            createdAt: nowTs
        };
        if (isEphemeral) msgDoc.expireAt = admin.firestore.Timestamp.fromMillis(now + 24 * 3600 * 1000);
        await dbf.collection("socialMessages").add(msgDoc);

        /* ---- MISE À JOUR DU MATCH (aperçu + non-lus) ---- */
        var preview = filtered ? filtered.slice(0, 120) : "📷 Foto";
        var unreadKey = "unread." + otherUid;
        var upd = { lastMessage: preview, lastAt: nowTs, updatedAt: nowTs };
        upd[unreadKey] = FieldValue.increment(1);
        await matchRef.set(upd, { merge: true });

        /* ---- NOTIF PUSH au destinataire (best effort) ---- */
        try {
            var myName = (match.names && match.names[uid]) || "yon moun";
            var rcvDoc = await dbf.collection("users").doc(otherUid).get();
            var tokens = (rcvDoc.exists && rcvDoc.data().fcmTokens) || [];
            if (tokens.length) {
                await admin.messaging().sendEachForMulticast({
                    tokens: tokens,
                    notification: { title: myName + " · Bizen Social", body: filtered ? filtered.slice(0, 100) : "📷 Foto" },
                    data: { link: "/social.html#matches" }
                });
            }
        } catch (e) {}

        return ok({ success: true });
    } catch (e) {
        console.error("[SOCIAL-MSG]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
