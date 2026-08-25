/* ====================================
   BIZEN HT — Compteurs d'articles (Espas Byennèt)
   Incrémente le nombre de LECTURES ou de PARTAGES d'un article.
   Public (pas d'auth) : ce sont de simples compteurs, aucune donnée sensible.
   Passe par le serveur car l'écriture sur `articles` est réservée à l'admin.
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
        var id = (body.id || "").toString();
        var action = (body.action || "view").toString();
        if (!id) return err(400, "id requis");
        var field = (action === "share") ? "shareCount" : "viewCount";

        var ref = admin.firestore().collection("articles").doc(id);
        var snap = await ref.get();
        if (!snap.exists) return err(404, "Atik pa jwenn.");   /* évite de créer un doc orphelin */
        await ref.update({ [field]: admin.firestore.FieldValue.increment(1) });

        return ok({ success: true });
    } catch (e) {
        console.error("[ARTICLE-STAT]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
