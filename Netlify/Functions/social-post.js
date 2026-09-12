/* ====================================
   BIZEN SOCIAL — Fil d'actualite (posts type Instagram)
   Toutes les ecritures passent par le serveur (Admin SDK) : anti triche,
   filtrage des coordonnees, comptage fiable des likes et commentaires.
   Actions (body.action) :
     create   : publie un post (image + legende + hashtags)
     like     : like / unlike (bascule) avec compteur atomique
     comment  : ajoute un commentaire (filtre) et incremente le compteur
     save     : sauvegarde / retire de la sauvegarde (bascule)
     delete   : supprime son propre post (ou admin)
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
function err(c, m) { return { statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) }; }

/* Masque les coordonnees externes (identique au reste du site). */
function filterContact(text) {
    var t = String(text == null ? "" : text);
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, "•••");
    t = t.replace(/(^|[\s.,!?])@\w{2,}/g, "$1•••");
    t = t.replace(/(\+?\d[\d\s().\-]{4,}\d)/g, "•••");
    t = t.replace(/\b(whats?ap?p?|wsp|watsap|telegram|signal|viber|imo|snapchat|snap|instagram|insta|\big\b|tiktok|facebook|\bfb\b|messenger|gmail|hotmail|yahoo|outlook|e?-?mail|imel|nimewo|numero|num[ée]ro)\b/gi, "•••");
    return t;
}

/* Extrait les hashtags d'une legende (#lanmou, #ayiti...). */
function extractTags(text) {
    var out = [], seen = {};
    var re = /#([\p{L}0-9_]{2,30})/gu, m;
    while ((m = re.exec(String(text || ""))) !== null) {
        var tag = m[1].toLowerCase();
        if (!seen[tag]) { seen[tag] = 1; out.push(tag); }
        if (out.length >= 10) break;
    }
    return out;
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var action = body.action;
        if (!idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var nowTs = admin.firestore.Timestamp.now();

        /* Mon profil Social (pour le pseudo et l'avatar affiches sur le post). */
        var meSnap = await dbf.collection("socialProfiles").doc(uid).get();
        if (!meSnap.exists) return err(404, "Ou poko gen yon pwofil Bizen Social.");
        var me = meSnap.data();
        if (me.status === "banned") return err(403, "Kont Social ou sispann.");
        var myName = me.pseudo || "Anonim";
        var myAvatar = (me.photos && me.photos[0]) || "";

        /* -------- CREER UN POST -------- */
        if (action === "create") {
            var imageUrl = (body.imageUrl || "").toString().slice(0, 600);
            var caption = (body.caption || "").toString().trim().slice(0, 2200);
            if (imageUrl && imageUrl.indexOf("https://") !== 0) return err(400, "Imaj pa valab.");

            /* Amis identifies (on garde seulement les noms pour l'affichage). */
            var taggedNames = [];
            if (Array.isArray(body.taggedNames)) {
                taggedNames = body.taggedNames.slice(0, 20).map(function (n) { return String(n || "").slice(0, 40); }).filter(Boolean);
            }

            var newPost = {
                authorUid: uid,
                authorName: myName,
                authorAvatar: myAvatar,
                imageUrl: imageUrl || "",
                mediaType: (body.mediaType === "video") ? "video" : "image",
                caption: filterContact(caption),
                hashtags: extractTags(caption),
                taggedNames: taggedNames,
                vibe: (["cho", "chill", "fet", "randevou", "pale", "nouvo"].indexOf(body.vibe) !== -1) ? body.vibe : "",
                likeCount: 0,
                commentCount: 0,
                repostCount: 0,
                createdAt: nowTs
            };

            /* -------- REPARTAGE (repost sur son propre fil) -------- */
            var repostOf = (body.repostOf || "").toString();
            if (repostOf) {
                var origRef = dbf.collection("socialPosts").doc(repostOf);
                var orig = await origRef.get();
                if (!orig.exists) return err(404, "Post orijinal pa egziste ankò.");
                var od = orig.data();
                /* On reprend le contenu original (snapshot) et on marque le repartage. */
                newPost.imageUrl = od.imageUrl || "";
                newPost.caption = od.caption || "";
                newPost.hashtags = od.hashtags || [];
                newPost.repostOf = repostOf;
                newPost.repostAuthorName = od.authorName || "";
                newPost.repostAuthorUid = od.authorUid || "";
                /* Le texte que le repartageur ajoute (optionnel). */
                newPost.repostComment = filterContact(caption).slice(0, 500);
                try { await origRef.set({ repostCount: admin.firestore.FieldValue.increment(1) }, { merge: true }); } catch (e) {}
            } else {
                if (!imageUrl && !caption) return err(400, "Ajoute yon imaj oswa yon tèks.");
            }

            var postRef = await dbf.collection("socialPosts").add(newPost);
            return ok({ success: true, postId: postRef.id });
        }

        var postId = (body.postId || "").toString();
        if (!postId) return err(400, "postId requis");
        var postRef = dbf.collection("socialPosts").doc(postId);

        /* -------- LIKE / UNLIKE (bascule, compteur atomique) -------- */
        if (action === "like") {
            var likeRef = dbf.collection("socialPostLikes").doc(postId + "_" + uid);
            var liked = await dbf.runTransaction(async function (t) {
                var pSnap = await t.get(postRef);
                if (!pSnap.exists) throw new Error("Post pa egziste.");
                var lSnap = await t.get(likeRef);
                if (lSnap.exists) {
                    t.delete(likeRef);
                    t.update(postRef, { likeCount: FieldValue.increment(-1) });
                    return false;
                } else {
                    t.set(likeRef, { postId: postId, uid: uid, createdAt: nowTs });
                    t.update(postRef, { likeCount: FieldValue.increment(1) });
                    return true;
                }
            });
            /* Notif au proprietaire du post quand on like (best effort). */
            if (liked) {
                try {
                    var pDoc = await postRef.get();
                    var ownerUid = pDoc.exists ? pDoc.data().authorUid : null;
                    if (ownerUid && ownerUid !== uid) {
                        var oDoc = await dbf.collection("users").doc(ownerUid).get();
                        var tokens = (oDoc.exists && oDoc.data().fcmTokens) || [];
                        if (tokens.length) {
                            await admin.messaging().sendEachForMulticast({
                                tokens: tokens,
                                notification: { title: "Bizen Social", body: myName + " renmen post ou a." },
                                data: { link: "/social.html" }
                            });
                        }
                    }
                } catch (e) {}
            }
            return ok({ success: true, liked: liked });
        }

        /* -------- COMMENTER -------- */
        if (action === "comment") {
            var text = (body.text || "").toString().trim().slice(0, 500);
            if (!text) return err(400, "Kòmantè vid.");
            var filtered = filterContact(text);
            await dbf.collection("socialPostComments").add({
                postId: postId, uid: uid, name: myName, avatar: myAvatar,
                text: filtered, createdAt: nowTs
            });
            await postRef.set({ commentCount: FieldValue.increment(1) }, { merge: true });
            return ok({ success: true });
        }

        /* -------- SAUVEGARDER / RETIRER (bascule) -------- */
        if (action === "save") {
            var saveRef = dbf.collection("socialSaves").doc(uid + "_" + postId);
            var s = await saveRef.get();
            if (s.exists) { await saveRef.delete(); return ok({ success: true, saved: false }); }
            await saveRef.set({ uid: uid, postId: postId, createdAt: nowTs });
            return ok({ success: true, saved: true });
        }

        /* -------- SUPPRIMER SON POST -------- */
        if (action === "delete") {
            var pDoc2 = await postRef.get();
            if (!pDoc2.exists) return ok({ success: true });
            if (pDoc2.data().authorUid !== uid && decoded.email !== "bizenht@gmail.com") {
                return err(403, "Ou pa ka efase post sa a.");
            }
            await postRef.delete();
            return ok({ success: true, deleted: true });
        }

        return err(400, "action envalid");
    } catch (e) {
        console.error("[SOCIAL-POST]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
