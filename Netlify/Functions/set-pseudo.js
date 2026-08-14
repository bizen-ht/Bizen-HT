/* ====================================
   BIZEN HT — Pseudo visible du VIP
   Le VIP choisit un pseudo (nom affiché aux Elus). On l'écrit sur son doc
   users, ET on met à jour RÉTROACTIVEMENT toutes les vues de profil déjà
   enregistrées (profileViews.viewerName) — car ces docs appartiennent aux
   Elus (eluUid) et le VIP ne peut pas les écrire côté client (règles).
   Ex : un Elu a vu "Junior" ; Junior met le pseudo "Arch" → l'Elu voit "Arch".
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
        if (!body.idToken) return err(401, "idToken requis");
        var pseudo = (body.pseudo || "").toString().trim().slice(0, 30);
        if (!pseudo) return err(400, "Pseudo vid.");

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();

        /* 1) Écrit le pseudo sur le compte du VIP. */
        await dbf.collection("users").doc(uid).set({ pseudo: pseudo }, { merge: true });

        /* 2) Met à jour rétroactivement le nom affiché dans les vues déjà
              enregistrées (toutes les vues faites PAR ce VIP). */
        var snap = await dbf.collection("profileViews").where("viewerUid", "==", uid).get();
        var updated = 0;
        var refs = [];
        snap.forEach(function (d) { refs.push(d.ref); });
        for (var i = 0; i < refs.length; i += 400) {
            var batch = dbf.batch();
            refs.slice(i, i + 400).forEach(function (r) { batch.update(r, { viewerName: pseudo }); });
            await batch.commit();
            updated += Math.min(400, refs.length - i);
        }

        return ok({ success: true, pseudo: pseudo, viewsUpdated: updated });
    } catch (e) {
        console.error("[SET-PSEUDO]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
