/* ====================================
   BIZEN HT — Validation ADMIN d'un paiement NatCash manuel
   L'admin a vérifié sur son compte NatCash que l'argent est bien arrivé,
   puis valide (confirm) ou rejette (reject) le Transaction ID.
   confirm => active Premium (par email) OU marque la réservation payée,
   exactement comme le webhook Bazik. Réservé à l'admin.
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
        var txId = (body.transactionId || "").toString().trim();
        var action = (body.action === "reject") ? "reject" : "confirm";
        if (!txId) return err(400, "transactionId requis");

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        if (!decoded || decoded.email !== ADMIN_EMAIL) return err(403, "Admin sèlman.");

        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var docRef = dbf.collection("natcashPayments").doc(txId);
        var snap = await docRef.get();
        if (!snap.exists) return err(404, "Peman pa jwenn.");
        var p = snap.data();

        /* ---- REJET ---- */
        if (action === "reject") {
            await docRef.update({ status: "rejected", reviewedAt: FieldValue.serverTimestamp(), reviewedBy: decoded.email });
            return ok({ success: true, status: "rejected" });
        }

        /* ---- CONFIRMATION ---- */
        if (p.status === "confirmed") return ok({ success: true, already: true });

        if (p.purpose === "premium") {
            var targetUid = p.targetUid;
            if (!targetUid && p.email) {
                var q = await dbf.collection("users").where("email", "==", p.email).limit(1).get();
                if (!q.empty) targetUid = q.docs[0].id;
            }
            if (!targetUid) return err(400, "Pa jwenn okenn kont Bizen ak imel sa a. Verifye imel la.");
            await dbf.collection("users").doc(targetUid).set({
                isPremium: true, premiumActivatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            /* Trace dans payments (pour les rapports finance). */
            await dbf.collection("payments").add({
                userId: targetUid, email: p.email || "", method: "natcash",
                amount: p.amount || 1000, purpose: "premium", status: "confirmed",
                natcashId: txId, createdAt: FieldValue.serverTimestamp()
            });
        } else {
            /* Réservation : refléter le paiement (comme le webhook). */
            if (p.reservationId) {
                var rRef = dbf.collection("reservations").doc(p.reservationId);
                var rs = await rRef.get();
                if (rs.exists) {
                    var upd = { paid: true, paidAt: FieldValue.serverTimestamp() };
                    if (rs.data().status === "en_attente_peman") upd.status = "en_attente";
                    await rRef.update(upd);
                }
                await dbf.collection("payments").add({
                    userId: p.targetUid || "", method: "natcash", amount: p.amount || 0,
                    purpose: "reservation", reservationId: p.reservationId, status: "confirmed",
                    natcashId: txId, createdAt: FieldValue.serverTimestamp()
                });
            }
        }

        await docRef.update({ status: "confirmed", confirmedAt: FieldValue.serverTimestamp(), confirmedBy: decoded.email });
        return ok({ success: true, status: "confirmed" });
    } catch (e) {
        console.error("[NATCASH-VERIFY]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
