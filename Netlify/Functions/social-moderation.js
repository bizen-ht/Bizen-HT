/* ====================================
   BIZEN SOCIAL — Sécurité : BLOQUER / SIGNALER (obligatoire stores UGC)
   Actions (body.action) :
   - "block"   : bloque un utilisateur (réciproque : retiré des feeds + msg coupée)
   - "unblock" : retire le blocage
   - "report"  : signale un profil/message -> file de modération admin
   Toutes les écritures passent par le serveur (Admin SDK).
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
        var action = body.action;
        var targetUid = (body.targetUid || "").toString();

        if (!idToken) return err(401, "idToken requis");
        if (!targetUid) return err(400, "targetUid requis");
        if (["block", "unblock", "report"].indexOf(action) === -1) return err(400, "action envalid");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        if (uid === targetUid) return err(400, "Aksyon envalid.");
        var dbf = admin.firestore();
        var nowTs = admin.firestore.Timestamp.now();

        if (action === "block") {
            await dbf.collection("socialBlocks").doc(uid + "_" + targetUid).set({
                blocker: uid, target: targetUid, createdAt: nowTs
            }, { merge: true });
            return ok({ success: true, blocked: true });
        }

        if (action === "unblock") {
            try { await dbf.collection("socialBlocks").doc(uid + "_" + targetUid).delete(); } catch (e) {}
            return ok({ success: true, blocked: false });
        }

        /* action === "report" : signalement vers la file de modération admin. */
        var reason = (body.reason || "autre").toString().slice(0, 40);
        var details = (body.details || "").toString().slice(0, 500);
        var pairId = (body.pairId || "").toString().slice(0, 120);
        await dbf.collection("socialReports").add({
            reporter: uid,
            target: targetUid,
            reason: reason,
            details: details,
            pairId: pairId,
            status: "open",
            createdAt: nowTs
        });

        /* Bloque aussi automatiquement la personne signalée (protection immédiate). */
        try {
            await dbf.collection("socialBlocks").doc(uid + "_" + targetUid).set({
                blocker: uid, target: targetUid, createdAt: nowTs, viaReport: true
            }, { merge: true });
        } catch (e) {}

        /* Cloche admin (réutilise la collection existante adminNotifs). */
        try {
            await dbf.collection("adminNotifs").add({
                type: "socialReport",
                title: "Signalement Bizen Social",
                body: "Motif: " + reason,
                target: targetUid,
                reporter: uid,
                read: false,
                createdAt: nowTs
            });
        } catch (e) {}

        return ok({ success: true, reported: true });
    } catch (e) {
        console.error("[SOCIAL-MOD]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
