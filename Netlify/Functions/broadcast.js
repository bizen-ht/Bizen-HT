/* ====================================
   BIZEN HT — Diffusion (notifications push marketing)
   L'admin envoie une notification "Bizen" à un segment d'utilisateurs.
   Segments : free | premium | users (free+premium) | elu | everyone
   Sécurité : admin uniquement (idToken vérifié).
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
function ok(b) { return { statusCode: 200, headers: CORS, body: JSON.stringify(b) }; }
function err(c, m) { return { statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) }; }

/* L'utilisateur appartient-il au segment demandé ? */
function inSegment(u, seg) {
    var isElu = u.type === "freelancer";
    var isKrey = u.type === "krey";
    var isClient = !isElu && !isKrey;        /* type "user" ou absent */
    var isPrem = u.isPremium === true;
    switch (seg) {
        case "free":     return isClient && !isPrem;
        case "premium":  return isClient && isPrem;
        case "users":    return isClient;                 /* gratuit + payant */
        case "elu":      return isElu;
        case "everyone": return true;
        default:         return false;
    }
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var segment = (body.segment || "").toString();
        var title = (body.title || "Bizen HT").toString().trim().slice(0, 80);
        var msg = (body.message || "").toString().trim().slice(0, 300);
        var link = (body.link || "/").toString().slice(0, 200);

        if (!idToken) return err(401, "idToken requis");
        if (!msg) return err(400, "Mesaj vid.");
        if (["free", "premium", "users", "elu", "everyone"].indexOf(segment) === -1)
            return err(400, "Segman pa valab.");

        var decoded = await admin.auth().verifyIdToken(idToken);
        if (!decoded || decoded.email !== ADMIN_EMAIL) return err(403, "Admin sèlman.");

        var dbf = admin.firestore();
        var snap = await dbf.collection("users").get();

        var tokens = [];
        var matched = 0;
        snap.forEach(function (doc) {
            var u = doc.data();
            if (!inSegment(u, segment)) return;
            matched++;
            var ts = u.fcmTokens || [];
            for (var i = 0; i < ts.length; i++) {
                if (ts[i] && tokens.indexOf(ts[i]) === -1) tokens.push(ts[i]);
            }
        });

        if (!tokens.length) {
            return ok({ success: true, matchedUsers: matched, tokens: 0, sent: 0,
                note: "Okenn moun nan segman sa a pa gen notifikasyon aktive." });
        }

        /* Envoi par lots de 500 (limite FCM multicast) */
        var sent = 0, failed = 0, invalid = [];
        for (var b = 0; b < tokens.length; b += 500) {
            var batch = tokens.slice(b, b + 500);
            var resp = await admin.messaging().sendEachForMulticast({
                tokens: batch,
                notification: { title: title, body: msg },
                data: { link: link },
                webpush: { fcmOptions: { link: link } }
            });
            sent += resp.successCount;
            failed += resp.failureCount;
            resp.responses.forEach(function (r, i) {
                if (!r.success) {
                    var code = r.error && r.error.code ? r.error.code : "";
                    if (code.indexOf("registration-token-not-registered") !== -1 ||
                        code.indexOf("invalid-argument") !== -1) invalid.push(batch[i]);
                }
            });
        }

        /* Historique (optionnel) */
        try {
            await dbf.collection("broadcasts").add({
                segment: segment, title: title, message: msg,
                matchedUsers: matched, tokens: tokens.length, sent: sent, failed: failed,
                by: decoded.email,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) { /* ignore */ }

        /* Nettoyage best-effort des jetons invalides */
        if (invalid.length) {
            try {
                var users2 = await dbf.collection("users").get();
                var batchW = dbf.batch();
                users2.forEach(function (doc) {
                    var ts = (doc.data().fcmTokens) || [];
                    var bad = ts.filter(function (t) { return invalid.indexOf(t) !== -1; });
                    if (bad.length) {
                        batchW.update(doc.ref, { fcmTokens: admin.firestore.FieldValue.arrayRemove.apply(null, bad) });
                    }
                });
                await batchW.commit();
            } catch (e) { /* ignore */ }
        }

        return ok({ success: true, matchedUsers: matched, tokens: tokens.length, sent: sent, failed: failed });
    } catch (e) {
        console.error("[BROADCAST]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
