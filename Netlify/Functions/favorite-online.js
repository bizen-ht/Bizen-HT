/* ====================================
   BIZEN HT — Notif "ton favori est en ligne"
   Appelée par le dashboard de l'Elu quand il/elle passe EN LIGNE (au login).
   Le serveur retrouve tous les VIP qui ont mis cet Elu en favori et leur
   envoie une push "‹Elu› dispo kounye a 💗".

   Anti-spam : throttle PAR ELU (6h). Même si l'Elu se reconnecte 10x, ses
   fans ne reçoivent la notif qu'une fois toutes les 6h max.
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

var THROTTLE_MS = 6 * 3600 * 1000;   /* 6 heures */

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        if (!body.idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        var eluUid = decoded.uid;
        var dbf = admin.firestore();

        /* Charge l'Elu : doit être un prestataire actif. */
        var eluSnap = await dbf.collection("users").doc(eluUid).get();
        if (!eluSnap.exists) return err(404, "Kont pa jwenn.");
        var elu = eluSnap.data();
        if (elu.type !== "freelancer" && elu.type !== "krey") return ok({ skipped: "pa yon elu" });
        if (elu.status && elu.status !== "active") return ok({ skipped: "pa aktif" });

        var name = elu.pseudo || ((elu.prenom || "") + " " + (elu.nomInitial || elu.nom || "")).trim() || "Yon Elu";

        /* Throttle par Elu (stocké sur le profil public). */
        var pubRef = dbf.collection("publicProfiles").doc(eluUid);
        var pubSnap = await pubRef.get();
        var last = pubSnap.exists && pubSnap.data().onlineNotifiedAt && pubSnap.data().onlineNotifiedAt.toMillis
            ? pubSnap.data().onlineNotifiedAt.toMillis() : 0;
        if (Date.now() - last < THROTTLE_MS) return ok({ throttled: true });
        await pubRef.set({ onlineNotifiedAt: admin.firestore.Timestamp.now() }, { merge: true });

        /* VIP qui ont mis cet Elu en favori (par UID fiable). */
        var favSnap = await dbf.collection("users").where("favoriteUids", "array-contains", eluUid).limit(400).get();
        var tokens = [];
        favSnap.forEach(function (d) {
            var u = d.data();
            if (d.id === eluUid) return;
            (u.fcmTokens || []).forEach(function (t) { if (t) tokens.push(t); });
        });
        if (!tokens.length) return ok({ sent: 0, fans: favSnap.size });

        var link = "/?p=" + encodeURIComponent(eluUid);
        var sent = 0;
        /* FCM multicast = max 500 jetons par appel. */
        for (var i = 0; i < tokens.length; i += 500) {
            var batch = tokens.slice(i, i + 500);
            var resp = await admin.messaging().sendEachForMulticast({
                tokens: batch,
                notification: { title: name + " dispo kounye a 💗", body: "Yon Elu ou renmen sot konekte sou Bizen HT. Vin wè l!" },
                data: { link: link },
                webpush: { fcmOptions: { link: link } }
            });
            sent += resp.successCount;
            /* Nettoyage best-effort des jetons morts */
            var invalid = [];
            resp.responses.forEach(function (r, k) {
                if (!r.success) {
                    var code = (r.error && r.error.code) || "";
                    if (code.indexOf("registration-token-not-registered") !== -1 || code.indexOf("invalid-argument") !== -1) {
                        invalid.push(batch[k]);
                    }
                }
            });
            /* (nettoyage détaillé par user omis ici : notify.js le fait déjà au fil des envois) */
        }

        return ok({ sent: sent, fans: favSnap.size });
    } catch (e) {
        console.error("[FAVORITE-ONLINE]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
