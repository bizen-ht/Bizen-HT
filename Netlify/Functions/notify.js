/* ====================================
   BIZEN HT — Envoi de notifications push (FCM)
   Appelé par le client (avec son idToken) pour notifier un autre
   utilisateur (nouveau message, nouvelle réservation, etc.).
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

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS, body: "" };
    }
    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var toUid = body.toUid;
        var title = (body.title || "Bizen HT").toString().slice(0, 80);
        var msg = (body.msg || "").toString().slice(0, 160);
        var link = (body.link || "/Dashboard.html").toString().slice(0, 200);

        if (!idToken || !toUid) {
            return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "idToken & toUid requis" }) };
        }

        /* Vérifie l'appelant (anti-spam : seul un utilisateur connecté peut notifier) */
        await admin.auth().verifyIdToken(idToken);

        var db = admin.firestore();
        var doc = await db.collection("users").doc(toUid).get();
        var tokens = (doc.exists && doc.data().fcmTokens) || [];
        if (!tokens.length) {
            return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0 }) };
        }

        var resp = await admin.messaging().sendEachForMulticast({
            tokens: tokens,
            notification: { title: title, body: msg },
            data: { link: link },
            webpush: { fcmOptions: { link: link } }
        });

        /* Nettoie les jetons invalides */
        var invalid = [];
        resp.responses.forEach(function (r, i) {
            if (!r.success) {
                var code = r.error && r.error.code ? r.error.code : "";
                if (code.indexOf("registration-token-not-registered") !== -1 ||
                    code.indexOf("invalid-argument") !== -1) {
                    invalid.push(tokens[i]);
                }
            }
        });
        if (invalid.length) {
            await db.collection("users").doc(toUid).update({
                fcmTokens: admin.firestore.FieldValue.arrayRemove.apply(null, invalid)
            }).catch(function () {});
        }

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: resp.successCount }) };
    } catch (e) {
        console.error("[NOTIFY]", e.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
};
