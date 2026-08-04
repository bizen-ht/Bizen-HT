/* ====================================
   BIZEN HT — Remboursement wallet
   Quand une réservation payée par WALLET est annulée/refusée, on re-crédite le
   VIP. Autorisé UNIQUEMENT à : l'Elu concerné (prestateId) ou l'admin.
   Idempotent via `walletRefunded`.
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

var ADMIN_EMAIL = "bizenht@gmail.com";
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
        var idToken = (body.idToken || "").toString();
        var reservationId = (body.reservationId || "").toString();
        if (!idToken) return err(401, "idToken requis");
        if (!reservationId) return err(400, "reservationId requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var isAdmin = decoded.email === ADMIN_EMAIL;
        var dbf = admin.firestore();

        var resRef = dbf.collection("reservations").doc(reservationId);
        var resSnap = await resRef.get();
        if (!resSnap.exists) return err(404, "Rezèvasyon pa jwenn.");
        var r = resSnap.data();

        /* Rien à rembourser si pas payé par wallet ou déjà remboursé. */
        if (r.paidVia !== "wallet" || r.walletRefunded === true) {
            return ok({ success: true, refunded: false });
        }
        /* Autorisation : admin ou l'Elu de la réservation. */
        if (!isAdmin && r.prestateId !== uid) return err(403, "Ou pa ka ranbouse rezèvasyon sa a.");

        var amount = Math.round(parseFloat(r.amount || String(r.price || "0").replace(/[^0-9]/g, "")) || 0);
        var userRef = dbf.collection("users").doc(r.userId);

        await dbf.runTransaction(async function (t) {
            var rSnap = await t.get(resRef);
            var rr = rSnap.exists ? rSnap.data() : {};
            if (rr.walletRefunded === true) return;   /* déjà fait */
            var uSnap = await t.get(userRef);
            var bal = (uSnap.exists && parseFloat(uSnap.data().walletBalance)) || 0;
            t.set(userRef, { walletBalance: bal + amount }, { merge: true });
            t.update(resRef, { walletRefunded: true, walletRefundedAt: admin.firestore.Timestamp.now() });
        });

        return ok({ success: true, refunded: true, amount: amount });
    } catch (e) {
        console.error("[WALLET-REFUND]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
