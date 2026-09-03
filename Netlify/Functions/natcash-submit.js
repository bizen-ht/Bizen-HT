/* ====================================
   BIZEN HT — Paiement NatCash MANUEL (soumission client)
   L'API NatCash officielle n'est pas dispo => méthode manuelle :
   le client paie sur le numéro Bizen, puis entre son Transaction ID (14 chiffres).
   - Unicité GARANTIE : le doc id = le Transaction ID => impossible de l'utiliser 2x.
   - Statut "pending" : l'admin vérifie sur son compte NatCash puis valide
     (natcash-verify) => Premium/réservation s'active.
   Premium : on demande l'email du compte Bizen à créditer.
   Réservation : pas d'email (le compte est déjà connecté) — on lit la réservation.
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

var PREMIUM_PRICE = 1000;

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        if (!body.idToken) return err(401, "Ou dwe konekte pou fè yon depo.");

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        var uid = decoded.uid;
        var callerEmail = (decoded.email || "").toLowerCase();
        var dbf = admin.firestore();

        /* Transaction ID : EXACTEMENT 14 chiffres. */
        var txId = (body.transactionId || "").toString().trim();
        if (!/^\d{14}$/.test(txId)) return err(400, "Transaction ID a dwe gen egzakteman 14 chif (chif sèlman).");

        var purpose = (body.purpose === "reservation") ? "reservation" : "premium";

        var rec = {
            transactionId: txId,
            method: "natcash",
            purpose: purpose,
            submittedByUid: uid,
            submittedByEmail: callerEmail,
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (purpose === "premium") {
            var email = (body.email || "").toString().trim().toLowerCase();
            if (!email || email.indexOf("@") === -1) return err(400, "Antre imel kont Bizen ki fè peman an.");
            rec.email = email;
            rec.amount = PREMIUM_PRICE;
            /* On résout le compte cible (pour l'activation à la validation). */
            var q = await dbf.collection("users").where("email", "==", email).limit(1).get();
            rec.targetUid = q.empty ? null : q.docs[0].id;
        } else {
            var resId = (body.reservationId || "").toString();
            if (!resId) return err(400, "reservationId manke.");
            var rs = await dbf.collection("reservations").doc(resId).get();
            if (!rs.exists) return err(404, "Rezèvasyon pa jwenn.");
            var rd = rs.data();
            if (rd.userId !== uid) return err(403, "Se pa rezèvasyon ou.");
            rec.reservationId = resId;
            rec.targetUid = uid;
            rec.email = callerEmail;   /* pour l'affichage admin */
            rec.amount = parseInt(String(rd.price || rd.amount || "0").replace(/[^0-9]/g, ""), 10) || 0;
            /* Nom de l'Elu + date/heure : aide l'admin à identifier LA bonne
               réservation si le VIP en tente plusieurs à la fois. */
            rec.eluName = rd.prestateName || rd.eluName || rd.prestateNom || "";
            rec.resDate = rd.date || "";
            rec.resTime = rd.time || "";
        }

        /* UNICITÉ : doc id = Transaction ID. Transaction atomique => jamais 2x. */
        var docRef = dbf.collection("natcashPayments").doc(txId);
        try {
            await dbf.runTransaction(async function (t) {
                var d = await t.get(docRef);
                if (d.exists) { var e = new Error("used"); e._used = true; throw e; }
                t.set(docRef, rec);
            });
        } catch (e) {
            if (e && e._used) return err(409, "Transaction ID sa a deja itilize. Chak ID sèvi yon sèl fwa.");
            throw e;
        }

        return ok({ success: true, status: "pending", message: "Depo w resevwa! N ap verifye peman an epi aktive kont ou." });
    } catch (e) {
        console.error("[NATCASH-SUBMIT]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
