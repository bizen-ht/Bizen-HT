/* ====================================
   BIZEN SOCIAL — Stories (éphémères 24h)
   Actions :
     create : publie une story (image ou vidéo + texte optionnel), expire 24h
     delete : supprime sa propre story
   Lecture des stories = côté client (socialStories, expireAt > now).
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

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var action = body.action || "create";
        if (!idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();
        var now = Date.now();
        var nowTs = admin.firestore.Timestamp.fromMillis(now);

        var meSnap = await dbf.collection("socialProfiles").doc(uid).get();
        if (!meSnap.exists) return err(404, "Ou poko gen yon pwofil Bizen Social.");
        var me = meSnap.data();
        if (me.status === "banned") return err(403, "Kont Social ou sispann.");

        if (action === "delete") {
            var sid = (body.storyId || "").toString();
            if (!sid) return err(400, "storyId requis");
            var sRef = dbf.collection("socialStories").doc(sid);
            var sDoc = await sRef.get();
            if (sDoc.exists && (sDoc.data().authorUid === uid || decoded.email === "bizenht@gmail.com")) {
                await sRef.delete();
            }
            return ok({ success: true });
        }

        /* create */
        var imageUrl = (body.imageUrl || "").toString().slice(0, 600);
        var text = (body.text || "").toString().trim().slice(0, 200);
        if (!imageUrl) return err(400, "Ajoute yon foto oswa videyo pou story a.");
        if (imageUrl.indexOf("https://") !== 0) return err(400, "Medya pa valab.");
        var mediaType = (body.mediaType === "video") ? "video" : "image";

        var storyRef = await dbf.collection("socialStories").add({
            authorUid: uid,
            authorName: me.pseudo || "Anonim",
            authorAvatar: (me.photos && me.photos[0]) || "",
            imageUrl: imageUrl,
            mediaType: mediaType,
            text: text,
            vibe: (["cho", "chill", "fet", "randevou", "pale", "nouvo"].indexOf(body.vibe) !== -1) ? body.vibe : "",
            viewCount: 0,
            createdAt: nowTs,
            expireAt: admin.firestore.Timestamp.fromMillis(now + 24 * 3600 * 1000)
        });
        return ok({ success: true, storyId: storyRef.id });
    } catch (e) {
        console.error("[SOCIAL-STORY]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
