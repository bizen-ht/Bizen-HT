/* ====================================
   BIZEN SOCIAL — Actions de modération ADMIN (réservé à l'admin)
   Vérifie que l'appelant est l'admin (email), puis :
   - deletePost   : supprime un post + ses likes/commentaires/sauvegardes (cascade)
   - banProfile   : bannit un membre (status=banned, retiré des feeds)
   - unbanProfile : réactive un membre
   - resolveReport: classe un signalement (status=handled)
   Toutes les écritures passent par le serveur (Admin SDK).
   ==================================== */
const admin = require('firebase-admin');

var ADMIN_EMAIL = "bizenht@gmail.com";

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

/* Supprime tous les docs d'une requête, par lots. */
async function deleteQuery(dbf, q) {
    while (true) {
        var snap = await q.limit(400).get();
        if (snap.empty) break;
        var batch = dbf.batch();
        snap.forEach(function (d) { batch.delete(d.ref); });
        await batch.commit();
        if (snap.size < 400) break;
    }
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
        if (decoded.email !== ADMIN_EMAIL) return err(403, "Rezève pou administratè.");

        var dbf = admin.firestore();
        var nowTs = admin.firestore.Timestamp.now();

        if (action === "deletePost") {
            var postId = (body.postId || "").toString();
            if (!postId) return err(400, "postId requis");
            try { await dbf.collection("socialPosts").doc(postId).delete(); } catch (e) {}
            await deleteQuery(dbf, dbf.collection("socialPostLikes").where("postId", "==", postId));
            await deleteQuery(dbf, dbf.collection("socialPostComments").where("postId", "==", postId));
            await deleteQuery(dbf, dbf.collection("socialSaves").where("postId", "==", postId));
            return ok({ success: true });
        }

        if (action === "banProfile" || action === "unbanProfile") {
            var uid = (body.uid || "").toString();
            if (!uid) return err(400, "uid requis");
            var banned = action === "banProfile";
            var upd = { status: banned ? "banned" : "active" };
            if (banned) { upd.visible = false; upd.discoverable = false; }
            await dbf.collection("socialProfiles").doc(uid).set(upd, { merge: true });
            return ok({ success: true, banned: banned });
        }

        if (action === "resolveReport") {
            var reportId = (body.reportId || "").toString();
            if (!reportId) return err(400, "reportId requis");
            await dbf.collection("socialReports").doc(reportId).set(
                { status: "handled", handledAt: nowTs, handledBy: decoded.uid }, { merge: true });
            return ok({ success: true });
        }

        return err(400, "action envalid");
    } catch (e) {
        console.error("[SOCIAL-ADMIN]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
