/* ====================================
   BIZEN HT — Suppression de compte par le VIP lui-même
   Le VIP (kliyan) peut effacer son propre compte depuis ses paramètres.
   Tout passe par le serveur (Admin SDK) car :
     - le client ne peut pas effacer ses fils DM (règles),
     - et surtout il faut supprimer le compte Firebase Auth (sinon l'email
       reste « pris » et l'utilisateur ne peut pas se réinscrire).

   Sécurité : on n'efface QUE le compte de l'appelant (uid tiré du idToken
   vérifié). Réservé aux comptes VIP (type "user") — un Elu a des paiements /
   réservations en cours, il doit passer par le support.
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

/* Efface tous les fils DM + messages où `uid` est participant (par lots). */
async function purgeUserDMs(dbf, uid) {
    var snap = await dbf.collection("dmThreads").where("participants", "array-contains", uid).get();
    var threadIds = [];
    snap.forEach(function (d) { threadIds.push(d.id); });

    /* Messages de chaque fil */
    for (var t = 0; t < threadIds.length; t++) {
        var msgs = await dbf.collection("dmMessages").where("threadId", "==", threadIds[t]).get();
        var mrefs = [];
        msgs.forEach(function (d) { mrefs.push(d.ref); });
        for (var i = 0; i < mrefs.length; i += 400) {
            var mb = dbf.batch();
            mrefs.slice(i, i + 400).forEach(function (r) { mb.delete(r); });
            await mb.commit();
        }
    }
    /* Les fils eux-mêmes */
    var trefs = [];
    snap.forEach(function (d) { trefs.push(d.ref); });
    for (var j = 0; j < trefs.length; j += 400) {
        var tb = dbf.batch();
        trefs.slice(j, j + 400).forEach(function (r) { tb.delete(r); });
        await tb.commit();
    }
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        if (!idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();

        /* Vérifie le type de compte : réservé au VIP (kliyan). */
        var userSnap = await dbf.collection("users").doc(uid).get();
        var type = userSnap.exists ? (userSnap.data().type || "") : "";
        if (type && type !== "user") {
            return err(403, "Sèlman kont VIP ka efase tèt yo isit la. Kontakte sipò pou lòt kalite kont.");
        }

        /* 1) Efface toutes les conversations DM du compte. */
        try { await purgeUserDMs(dbf, uid); } catch (e) { console.error("[DEL] DM purge:", e.message); }

        /* 2) Retire le profil public (au cas où) + le doc user. */
        try { await dbf.collection("publicProfiles").doc(uid).delete(); } catch (e) {}
        try { await dbf.collection("users").doc(uid).delete(); } catch (e) {}

        /* 3) Supprime le compte d'authentification (libère l'email). */
        try { await admin.auth().deleteUser(uid); } catch (e) { console.error("[DEL] auth:", e.message); }

        return ok({ success: true });
    } catch (e) {
        console.error("[DELETE-ACCOUNT]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
