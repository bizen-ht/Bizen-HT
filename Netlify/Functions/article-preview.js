/* ====================================
   BIZEN HT — Aperçu (preview) d'un article Espas Byennèt pour partage
   Sert le lien /atik/<id> :
   - Pou robo rezo sosyal (WhatsApp/FB/Twitter) : li balise Open Graph yo
     (imaj + tit + rezime) => bèl aperçu AVAN klike.
   - Pou yon vrè navigatè : li redirije sou app la (/?atik=<id>) ki ouvri atik la.
   Done yo soti nan `articles` (piblik lè published==true).
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

var SITE = "https://bizenht.com";
function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

exports.handler = async function (event) {
    /* id : d'abord ?id=..., sinon extrait du chemin (/atik/<id>). */
    var id = ((event.queryStringParameters && event.queryStringParameters.id) || "").toString();
    if (!id && event.path) {
        var m = String(event.path).match(/\/(?:atik|article-preview)\/([^\/?#]+)/i);
        if (m) { try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; } }
    }
    id = id.trim();

    var appUrl = SITE + "/#byennet";
    var title = "Espas Byennèt — Bizen HT";
    var desc = "Konesans, plezi ak libète — san tabou, san jijman. Sou Bizen HT.";
    var image = SITE + "/images/header-fanm.jpg";

    try {
        if (id) {
            init();
            var doc = await admin.firestore().collection("articles").doc(id).get();
            if (doc.exists) {
                var d = doc.data();
                appUrl = SITE + "/?atik=" + encodeURIComponent(id);
                if (d.title) title = d.title + " — Espas Byennèt | Bizen HT";
                if (d.excerpt) desc = d.excerpt;
                else if (d.body) desc = String(d.body).slice(0, 160);
                if (d.imageUrl) image = d.imageUrl;
            }
        }
    } catch (e) {
        console.warn("[ARTICLE-PREVIEW]", e.message);
    }

    var html = '<!DOCTYPE html><html lang="ht"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<title>' + esc(title) + '</title>'
        + '<meta name="robots" content="index, follow, max-image-preview:large">'
        + '<meta property="og:type" content="article">'
        + '<meta property="og:site_name" content="Bizen HT">'
        + '<meta property="og:locale" content="ht_HT">'
        + '<meta property="og:title" content="' + esc(title) + '">'
        + '<meta property="og:description" content="' + esc(desc) + '">'
        + '<meta property="og:image" content="' + esc(image) + '">'
        + '<meta property="og:url" content="' + esc(appUrl) + '">'
        + '<meta name="twitter:card" content="summary_large_image">'
        + '<meta name="twitter:title" content="' + esc(title) + '">'
        + '<meta name="twitter:description" content="' + esc(desc) + '">'
        + '<meta name="twitter:image" content="' + esc(image) + '">'
        + '<meta http-equiv="refresh" content="0;url=' + esc(appUrl) + '">'
        + '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>&#128151;</text></svg>">'
        + '<style>body{margin:0;background:#0a0a0f;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}</style>'
        + '</head><body>'
        + '<p>Chajman atik la...</p>'
        + '<script>location.replace(' + JSON.stringify(appUrl) + ');</script>'
        + '</body></html>';

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300"
        },
        body: html
    };
};
