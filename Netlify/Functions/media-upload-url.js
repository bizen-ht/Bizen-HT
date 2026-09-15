/* ====================================
   BIZEN SOCIAL — URL d'upload signée pour Cloudflare R2
   Le client demande une URL, puis envoie le fichier DIRECTEMENT vers R2
   (bande passante gratuite). On vérifie l'identité Firebase, le type et
   la taille avant de signer.
   Signature AWS Signature V4 faite à la main (aucune dépendance AWS).
   Variables d'env (Netlify) :
     R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
     R2_BUCKET, R2_PUBLIC_URL
   ==================================== */
const admin = require('firebase-admin');
const crypto = require('crypto');

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

function hmac(key, str) { return crypto.createHmac("sha256", key).update(str, "utf8").digest(); }
function sha256hex(str) { return crypto.createHash("sha256").update(str, "utf8").digest("hex"); }
function encSeg(s) { return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return "%" + c.charCodeAt(0).toString(16).toUpperCase(); }); }

/* Génère une URL PUT présignée (SigV4) pour R2. */
function presignPut(accountId, accessKeyId, secretKey, bucket, key, expires) {
    var region = "auto", service = "s3";
    var host = accountId + ".r2.cloudflarestorage.com";
    var now = new Date();
    var amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   /* YYYYMMDDTHHMMSSZ */
    var dateStamp = amzDate.slice(0, 8);
    var scope = dateStamp + "/" + region + "/" + service + "/aws4_request";
    var canonicalUri = "/" + bucket + "/" + key.split("/").map(encSeg).join("/");

    var q = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": accessKeyId + "/" + scope,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(expires || 300),
        "X-Amz-SignedHeaders": "host"
    };
    var canonicalQuery = Object.keys(q).sort().map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(q[k]);
    }).join("&");

    var canonicalRequest = [
        "PUT", canonicalUri, canonicalQuery,
        "host:" + host + "\n", "host", "UNSIGNED-PAYLOAD"
    ].join("\n");
    var stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

    var kDate = hmac("AWS4" + secretKey, dateStamp);
    var kRegion = hmac(kDate, region);
    var kService = hmac(kRegion, service);
    var kSigning = hmac(kService, "aws4_request");
    var signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

    return "https://" + host + canonicalUri + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
}

var EXT_BY_TYPE = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "image/heic": "heic",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp"
};

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var accountId = process.env.R2_ACCOUNT_ID, akid = process.env.R2_ACCESS_KEY_ID;
        var secret = process.env.R2_SECRET_ACCESS_KEY, bucket = process.env.R2_BUCKET;
        var publicUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
        if (!accountId || !akid || !secret || !bucket || !publicUrl) return err(500, "Konfigirasyon R2 poko fèt.");

        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        if (!idToken) return err(401, "idToken requis");
        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;

        var contentType = (body.contentType || "").toString().toLowerCase();
        var isImage = contentType.indexOf("image/") === 0;
        var isVideo = contentType.indexOf("video/") === 0;
        if (!isImage && !isVideo) return err(400, "Sèlman foto ak videyo otorize.");

        /* Taille annoncée par le client (contrôle indicatif). */
        var size = parseInt(body.size, 10) || 0;
        var maxImg = 15 * 1024 * 1024, maxVid = 200 * 1024 * 1024;
        if (isImage && size > maxImg) return err(400, "Foto twò gwo (max 15 Mo).");
        if (isVideo && size > maxVid) return err(400, "Videyo twò gwo (max 200 Mo).");

        var kind = (body.kind || "post").toString().replace(/[^a-z]/gi, "").slice(0, 12) || "post";
        var ext = EXT_BY_TYPE[contentType] || (isVideo ? "mp4" : "jpg");
        var rand = crypto.randomBytes(8).toString("hex");
        var key = "social/" + uid + "/" + kind + "/" + Date.now() + "_" + rand + "." + ext;

        var uploadUrl = presignPut(accountId, akid, secret, bucket, key, 600);
        return ok({ success: true, uploadUrl: uploadUrl, publicUrl: publicUrl + "/" + key, key: key });
    } catch (e) {
        console.error("[MEDIA-UPLOAD-URL]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
