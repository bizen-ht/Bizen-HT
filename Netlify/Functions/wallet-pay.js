/* ====================================
   BIZEN HT — Paiement d'une réservation depuis le WALLET du VIP
   Débit ATOMIQUE (transaction) : vérifie le solde, débite, marque la
   réservation payée. Le montant est le prix RÉEL de l'Elu (lu côté serveur),
   pas un montant fourni par le client => anti-triche.
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
function err(c, m, extra) { return { statusCode: c, headers: CORS, body: JSON.stringify(Object.assign({ error: m }, extra || {})) }; }

/* Prix effectif de l'Elu (base − rabais actif), lu depuis publicProfiles. */
function effectivePrice(d) {
    var base = Math.round(parseFloat((d && d.prixMoment) || 0)) || 0;
    var amt = Math.round(parseFloat((d && d.discountAmount) || 0)) || 0;
    var ends = 0;
    if (d && d.discountEndsAt && d.discountEndsAt.toMillis) ends = d.discountEndsAt.toMillis();
    else if (d && typeof d.discountEndsAt === "number") ends = d.discountEndsAt;
    var active = amt > 0 && ends > Date.now();
    return active ? Math.max(0, base - amt) : base;
}

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

        var resRef = dbf.collection("reservations").doc(reservationId);
        var resSnap = await resRef.get();
        if (!resSnap.exists) return err(404, "Rezèvasyon pa jwenn.");
        var r = resSnap.data();
        if (r.userId !== uid) return err(403, "Se pa rezèvasyon ou.");
        if (r.paid === true || r.paidVia === "wallet") return err(409, "Rezèvasyon sa a deja peye.");
        if (r.status === "cancelled") return err(409, "Rezèvasyon sa a anile.");

        /* Prix RÉEL de l'Elu (côté serveur). Repli : montant enregistré sur la résa. */
        var amount = 0;
        if (r.prestateId) {
            var ppSnap = await dbf.collection("publicProfiles").doc(r.prestateId).get();
            if (ppSnap.exists) amount = effectivePrice(ppSnap.data());
        }
        if (!amount) amount = Math.round(parseFloat(r.amount || String(r.price || "0").replace(/[^0-9]/g, "")) || 0);
        if (amount <= 0) return err(400, "Pri rezèvasyon an pa valab.");

        var userRef = dbf.collection("users").doc(uid);

        var out = await dbf.runTransaction(async function (t) {
            var uSnap = await t.get(userRef);
            var bal = (uSnap.exists && parseFloat(uSnap.data().walletBalance)) || 0;
            var rSnap = await t.get(resRef);
            var rr = rSnap.exists ? rSnap.data() : {};
            if (rr.paid === true || rr.paidVia === "wallet") throw { code: 409, msg: "Deja peye." };
            if (bal < amount) throw { code: 402, msg: "Solde wallet ou pa ase (" + bal + " Gdes). Rechaje wallet ou oswa peye dirèk.", balance: bal, needed: amount };
            t.update(userRef, { walletBalance: bal - amount });
            t.update(resRef, {
                paid: true, paidVia: "wallet",
                amount: amount, price: String(amount),
                status: (rr.status === "en_attente_peman" || rr.status === "en_attente") ? "en_attente" : rr.status,
                walletPaidAt: admin.firestore.Timestamp.now()
            });
            return { newBalance: bal - amount };
        });

        return ok({ success: true, amount: amount, newBalance: out.newBalance });
    } catch (e) {
        if (e && e.code && e.msg) return err(e.code, e.msg, { balance: e.balance, needed: e.needed });
        console.error("[WALLET-PAY]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
