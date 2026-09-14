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
                /* Nettoyage des vues de cette story. */
                try {
                    var vq = await dbf.collection("socialStoryViews").where("storyId", "==", sid).limit(400).get();
                    var vb = dbf.batch(); vq.forEach(function (d) { vb.delete(d.ref); }); await vb.commit();
                } catch (e) {}
            }
            return ok({ success: true });
        }

        /* -------- VUE d'une story (une seule fois par personne) -------- */
        if (action === "view") {
            var vid = (body.storyId || "").toString();
            if (!vid) return err(400, "storyId requis");
            var vRef = dbf.collection("socialStoryViews").doc(vid + "_" + uid);
            var vs = await vRef.get();
            if (!vs.exists) {
                await vRef.set({ storyId: vid, uid: uid, name: me.pseudo || "Anonim", avatar: (me.photos && me.photos[0]) || "", liked: false, createdAt: nowTs });
                try { await dbf.collection("socialStories").doc(vid).set({ viewCount: admin.firestore.FieldValue.increment(1) }, { merge: true }); } catch (e) {}
            }
            return ok({ success: true });
        }

        /* -------- LIKE d'une story (bascule) -------- */
        if (action === "like") {
            var lid = (body.storyId || "").toString();
            if (!lid) return err(400, "storyId requis");
            var lvRef = dbf.collection("socialStoryViews").doc(lid + "_" + uid);
            var cur = await lvRef.get();
            var wasLiked = cur.exists && cur.data().liked === true;
            await lvRef.set({ storyId: lid, uid: uid, name: me.pseudo || "Anonim", avatar: (me.photos && me.photos[0]) || "", liked: !wasLiked, createdAt: (cur.exists && cur.data().createdAt) || nowTs }, { merge: true });
            if (!wasLiked) {
                try {
                    var sd = await dbf.collection("socialStories").doc(lid).get();
                    if (sd.exists && sd.data().authorUid !== uid) {
                        var oD = await dbf.collection("users").doc(sd.data().authorUid).get();
                        var tk = (oD.exists && oD.data().fcmTokens) || [];
                        if (tk.length) await admin.messaging().sendEachForMulticast({ tokens: tk, notification: { title: "Bizen Social", body: (me.pseudo || "Yon moun") + " renmen story ou a." }, data: { link: "/social.html" } });
                    }
                } catch (e) {}
            }
            return ok({ success: true, liked: !wasLiked });
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
