/* ====================================
   BIZEN HT — Envoi d'un TEP (pourboire) depuis le WALLET du VIP
   Débit ATOMIQUE : vérifie le solde wallet du VIP, débite, et crédite l'Elu
   (collection teps) avec le mot optionnel. TEP réservé aux VIP Premium.
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

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = (body.idToken || "").toString();
        var eluUid = (body.eluUid || "").toString();
        var amount = parseInt(String(body.amount || "0").replace(/[^0-9]/g, ""), 10) || 0;
        var note = (body.note || "").toString().slice(0, 200);
        if (!idToken) return err(401, "idToken requis");
        if (!eluUid) return err(400, "eluUid requis");
        if (amount < 100) return err(400, "Montan TEP minimòm se 100 Gdes.");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        if (uid === eluUid) return err(400, "Ou pa ka voye tèt ou yon TEP.");
        var dbf = admin.firestore();

        /* Expéditeur : doit être Premium ; on récupère son pseudo. */
        var sSnap = await dbf.collection("users").doc(uid).get();
        var sender = sSnap.exists ? sSnap.data() : {};
        if (sender.isPremium !== true) return err(403, "TEP se pou VIP Premium.");
        var fromPseudo = sender.pseudo || sender.prenom || "VIP";

        /* Bénéficiaire : nom de l'Elu. */
        var eSnap = await dbf.collection("users").doc(eluUid).get();
        if (!eSnap.exists) return err(404, "Elu sa a pa jwenn.");
        var eluName = eSnap.data().pseudo || eSnap.data().prenom || "";

        var userRef = dbf.collection("users").doc(uid);
        var tepRef = dbf.collection("teps").doc();
        var FieldValue = admin.firestore.FieldValue;

        var out = await dbf.runTransaction(async function (t) {
            var uSnap = await t.get(userRef);
            var bal = (uSnap.exists && parseFloat(uSnap.data().walletBalance)) || 0;
            if (bal < amount) throw { code: 402, msg: "Solde wallet ou pa ase (" + bal + " Gdes). Rechaje wallet ou.", balance: bal, needed: amount };
            t.update(userRef, { walletBalance: bal - amount });
            t.set(tepRef, {
                eluUid: eluUid, eluName: eluName,
                fromUid: uid, fromPseudo: fromPseudo,
                amount: amount, status: "confirmed",
                note: note, method: "wallet",
                createdAt: FieldValue.serverTimestamp()
            });
            return { newBalance: bal - amount };
        });

        /* Notif push à l'Elu : il a reçu un TEP. */
        try {
            var tokens = (eSnap.data().fcmTokens) || [];
            if (tokens.length) {
                await admin.messaging().sendEachForMulticast({
                    tokens: tokens,
                    notification: {
                        title: "Ou resevwa yon TEP! 💛",
                        body: fromPseudo + " voye w " + amount.toLocaleString() + " Gdes" + (note ? " · " + note : "")
                    },
                    data: { link: "/Dashboard.html" }
                });
            }
        } catch (e) { /* best effort */ }

        return ok({ success: true, amount: amount, newBalance: out.newBalance });
    } catch (e) {
        if (e && e.code && e.msg) return err(e.code, e.msg, { balance: e.balance, needed: e.needed });
        console.error("[TEP-WALLET]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
