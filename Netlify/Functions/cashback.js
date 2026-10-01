/* ====================================
   BIZEN HT — Cashback wallet VIP (3%)
   Crédite 3% du montant d'une réservation PAYÉE PAR WALLET, au moment
   où la RENCONTRE est CONFIRMÉE (met:true). Crédit ATOMIQUE, une seule
   fois par réservation. Tout est revérifié côté serveur (anti-triche) :
   - le demandeur est bien le VIP propriétaire de la réservation,
   - la réservation est payée via wallet (paidVia === "wallet"),
   - la rencontre est confirmée (met === true),
   - le cashback n'a pas déjà été versé (cashbackCredited !== true).
   ==================================== */
const admin = require('firebase-admin');

var CASHBACK_PCT = 0.03;   /* 3% — cashback wallet VIP */

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
        var idToken = (body.idToken || "").toString();
        var reservationId = (body.reservationId || "").toString();
        if (!idToken) return err(401, "idToken requis");
        if (!reservationId) return err(400, "reservationId requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;

        var resRef = dbf.collection("reservations").doc(reservationId);
        var userRef = dbf.collection("users").doc(uid);
        var cbRef = dbf.collection("cashbacks").doc(reservationId);   /* id = résa => idempotent */

        var out = await dbf.runTransaction(async function (t) {
            var rSnap = await t.get(resRef);
            if (!rSnap.exists) throw { code: 404, msg: "Rezèvasyon pa jwenn." };
            var r = rSnap.data();

            /* Éligibilité (revérifiée côté serveur). */
            if (r.userId !== uid) throw { code: 403, msg: "Se pa rezèvasyon ou." };
            if (r.paidVia !== "wallet" || r.paid !== true) return { credited: false, reason: "not_wallet" };
            if (r.met !== true) return { credited: false, reason: "not_met" };
            if (r.cashbackCredited === true) return { credited: false, reason: "already" };

            var base = Math.round(parseFloat(r.amount || String(r.price || "0").replace(/[^0-9]/g, "")) || 0);
            var cash = Math.round(base * CASHBACK_PCT);
            if (cash <= 0) return { credited: false, reason: "zero" };

            var uSnap = await t.get(userRef);
            var bal = (uSnap.exists && parseFloat(uSnap.data().walletBalance)) || 0;

            t.update(userRef, { walletBalance: bal + cash });
            t.update(resRef, {
                cashbackCredited: true,
                cashbackAmount: cash,
                cashbackAt: FieldValue.serverTimestamp()
            });
            /* Trace (rapport / anti-double). */
            t.set(cbRef, {
                userId: uid, reservationId: reservationId,
                baseAmount: base, amount: cash, pct: CASHBACK_PCT,
                createdAt: FieldValue.serverTimestamp()
            });

            return { credited: true, cashback: cash, newBalance: bal + cash };
        });

        return ok(Object.assign({ success: true }, out));
    } catch (e) {
        if (e && e.code && e.msg) return err(e.code, e.msg);
        console.error("[CASHBACK]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
