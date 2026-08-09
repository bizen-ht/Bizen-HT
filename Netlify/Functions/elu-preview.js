/* ====================================
   BIZEN HT — Aperçu (preview) d'un profil Elu pour partage
   Sert le lien /pwofil/<kòd> :
   - Pou robo rezo sosyal (WhatsApp/FB/Twitter) : li li balise Open Graph yo
     (foto + non Elu a) => bèl aperçu AVAN klike.
   - Pou yon vrè navigatè : li redirije sou app la (/?p=<kòd>) ki ouvri pwofil
     la ak kontwòl aksè (konekte / premium).
   Done yo soti nan publicProfiles (piblik, san done sansib).
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
    /* Code : d'abord ?code=..., sinon on l'extrait du chemin (/pwofil/<code> ou
       /.netlify/functions/elu-preview/<code>) — plus robuste que le :splat en query. */
    var code = ((event.queryStringParameters && event.queryStringParameters.code) || "").toString();
    if (!code && event.path) {
        var m = String(event.path).match(/\/(?:pwofil|elu-preview)\/([^\/?#]+)/i);
        if (m) { try { code = decodeURIComponent(m[1]); } catch (e) { code = m[1]; } }
    }
    code = code.trim().toUpperCase();

    var appUrl = SITE + "/";                 /* défaut : accueil si rien trouvé */
    var title = "Pwofil Elu sou Bizen HT";
    var desc = "Dekouvri pwofil sa a sou Bizen HT — sit rankont #1 an Ayiti. Granmoun 18 an+.";
    var image = SITE + "/images/header-fanm.jpg";

    try {
        if (code) {
            init();
            var snap = await admin.firestore().collection("publicProfiles")
                .where("bizenCode", "==", code).limit(1).get();
            if (!snap.empty) {
                var d = snap.docs[0].data();
                /* On redirige avec l'UID (pas le code) : le client ouvre direct,
                   sans avoir besoin de re-résoudre le code. */
                appUrl = SITE + "/?p=" + encodeURIComponent(snap.docs[0].id);
                var name = (d.pseudo || ((d.prenom || "") + " " + (d.nomInitial || "")).trim() || "Elu");
                title = name + " — Elu sou Bizen HT";
                var loc = d.localisation ? (" · " + d.localisation) : "";
                var prix = d.prixMoment ? (" · " + Number(d.prixMoment).toLocaleString() + " Gdes") : "";
                desc = "Gade pwofil " + name + loc + prix + " sou Bizen HT. Granmoun 18 an+. Diskresyon total.";
                if (d.photoUrl) image = d.photoUrl;
            }
        }
    } catch (e) {
        console.warn("[ELU-PREVIEW]", e.message);
    }

    var html = '<!DOCTYPE html><html lang="ht"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<title>' + esc(title) + '</title>'
        + '<meta name="robots" content="noindex, follow, max-image-preview:large">'
        + '<meta name="rating" content="adult">'
        + '<meta property="og:type" content="profile">'
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
        + '<p>Chajman pwofil la...</p>'
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
