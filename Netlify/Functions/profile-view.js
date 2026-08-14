/* ====================================
   BIZEN HT — "Ki moun ki gade pwofil ou" (vues de profil)
   Appelée quand un VIP PREMIUM ouvre le profil d'un Elu.
   - Enregistre la vue dans profileViews (1 doc par paire Elu↔VIP).
   - Notifie l'Elu par push ("‹VIP› gade pwofil ou 👀"), dédupliqué : au max
     une push toutes les 12h par même VIP (sinon un VIP qui réouvre spammerait).
   Seuls les VIP Premium (type "user", isPremium) comptent — la vérif est faite
   côté serveur (le client ne peut pas mentir sur son statut Premium).
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

var NOTIFY_THROTTLE_MS = 12 * 3600 * 1000;   /* 12h entre deux push pour le même VIP */

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        if (!body.idToken) return err(401, "idToken requis");
        var eluUid = (body.eluUid || "").toString();
        if (!eluUid) return err(400, "eluUid requis");

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        var viewerUid = decoded.uid;
        if (viewerUid === eluUid) return ok({ skipped: "self" });

        var dbf = admin.firestore();

        /* Le viewer doit être un VIP Premium (vérif serveur). */
        var viewerSnap = await dbf.collection("users").doc(viewerUid).get();
        if (!viewerSnap.exists) return err(404, "Viewer pa jwenn.");
        var viewer = viewerSnap.data();
        if (viewer.type && viewer.type !== "user") return ok({ skipped: "pa VIP" });
        if (viewer.isPremium !== true) return ok({ skipped: "pa premium" });

        /* La cible doit être un Elu. */
        var eluSnap = await dbf.collection("users").doc(eluUid).get();
        if (!eluSnap.exists) return err(404, "Elu pa jwenn.");
        var elu = eluSnap.data();
        if (elu.type !== "freelancer" && elu.type !== "krey") return ok({ skipped: "pa elu" });

        /* Nom visible : le PSEUDO du VIP en priorité (vrai nom reste privé). */
        var viewerName = (viewer.pseudo || ((viewer.prenom || "") + " " + (viewer.nom || "")).trim() || "Yon VIP").slice(0, 60);

        /* 1 doc par paire => dédup + historique. */
        var vRef = dbf.collection("profileViews").doc(eluUid + "_" + viewerUid);
        var vSnap = await vRef.get();
        var prevLast = vSnap.exists && vSnap.data().lastAt && vSnap.data().lastAt.toMillis ? vSnap.data().lastAt.toMillis() : 0;
        var shouldNotify = (Date.now() - prevLast) >= NOTIFY_THROTTLE_MS;

        var upd = {
            eluUid: eluUid,
            viewerUid: viewerUid,
            viewerName: viewerName,
            viewerPremium: true,
            lastAt: admin.firestore.Timestamp.now(),
            count: admin.firestore.FieldValue.increment(1)
        };
        if (!vSnap.exists) upd.firstAt = admin.firestore.Timestamp.now();
        if (shouldNotify) upd.seenByElu = false;   /* remet en "nouveau" pour le badge */
        await vRef.set(upd, { merge: true });

        /* Push à l'Elu (best effort, throttlé). */
        var pushed = 0;
        if (shouldNotify) {
            var tokens = (elu.fcmTokens || []);
            if (tokens.length) {
                try {
                    var resp = await admin.messaging().sendEachForMulticast({
                        tokens: tokens,
                        notification: { title: viewerName + " gade pwofil ou 👀", body: "Yon manm Premium enterese ak ou sou Bizen HT." },
                        data: { link: "/Dashboard.html" },
                        webpush: { fcmOptions: { link: "/Dashboard.html" } }
                    });
                    pushed = resp.successCount;
                } catch (e) { /* ignore */ }
            }
        }

        return ok({ recorded: true, notified: shouldNotify, pushed: pushed });
    } catch (e) {
        console.error("[PROFILE-VIEW]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
