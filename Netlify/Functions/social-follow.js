/* ====================================
   BIZEN SOCIAL — S'abonner / se desabonner (follow)
   Bascule le suivi et maintient les compteurs (followersCount, followingCount)
   de facon atomique. Ecriture serveur uniquement (Admin SDK).
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
        var targetUid = (body.targetUid || "").toString();
        if (!idToken) return err(401, "idToken requis");
        if (!targetUid) return err(400, "targetUid requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        if (uid === targetUid) return err(400, "Ou pa ka swiv tèt ou.");

        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var nowTs = admin.firestore.Timestamp.now();

        var followRef = dbf.collection("socialFollows").doc(uid + "_" + targetUid);
        var meRef = dbf.collection("socialProfiles").doc(uid);
        var targetRef = dbf.collection("socialProfiles").doc(targetUid);

        var following = await dbf.runTransaction(async function (t) {
            var fSnap = await t.get(followRef);
            if (fSnap.exists) {
                t.delete(followRef);
                t.set(meRef, { followingCount: FieldValue.increment(-1) }, { merge: true });
                t.set(targetRef, { followersCount: FieldValue.increment(-1) }, { merge: true });
                return false;
            } else {
                t.set(followRef, { follower: uid, target: targetUid, createdAt: nowTs });
                t.set(meRef, { followingCount: FieldValue.increment(1) }, { merge: true });
                t.set(targetRef, { followersCount: FieldValue.increment(1) }, { merge: true });
                return true;
            }
        });

        /* Notif au profil suivi (best effort). */
        if (following) {
            try {
                var meDoc = await meRef.get();
                var myName = (meDoc.exists && meDoc.data().pseudo) || "yon moun";
                var oDoc = await dbf.collection("users").doc(targetUid).get();
                var tokens = (oDoc.exists && oDoc.data().fcmTokens) || [];
                if (tokens.length) {
                    await admin.messaging().sendEachForMulticast({
                        tokens: tokens,
                        notification: { title: "Bizen Social", body: myName + " kòmanse swiv ou." },
                        data: { link: "/social.html" }
                    });
                }
            } catch (e) {}
        }

        return ok({ success: true, following: following });
    } catch (e) {
        console.error("[SOCIAL-FOLLOW]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
