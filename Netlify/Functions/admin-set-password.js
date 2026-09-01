/* ====================================
   BIZEN HT — Réinitialisation de mot de passe par l'ADMIN
   Pour les VIP/Elu qui ont oublié leur mot de passe et ne peuvent pas
   utiliser le lien « bliye modpas » : l'admin leur attribue un nouveau
   mot de passe. Réservé à l'admin (idToken vérifié).
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

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        if (!body.idToken) return err(401, "idToken requis");
        var targetUid = (body.targetUid || "").toString();
        var newPassword = (body.newPassword || "").toString();
        if (!targetUid) return err(400, "targetUid requis");
        if (newPassword.length < 6) return err(400, "Modpas dwe gen omwen 6 karaktè.");

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        if (!decoded || decoded.email !== ADMIN_EMAIL) return err(403, "Admin sèlman.");

        await admin.auth().updateUser(targetUid, { password: newPassword });

        return ok({ success: true });
    } catch (e) {
        console.error("[ADMIN-SET-PASSWORD]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
