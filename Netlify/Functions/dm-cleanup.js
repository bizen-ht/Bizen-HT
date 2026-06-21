/* ====================================
   BIZEN HT — Nettoyage des messages éphémères (DM)
   Fonction PLANIFIÉE (voir netlify.toml : schedule).
   Supprime les messages dont expireAt <= maintenant (≈ 24h après l'envoi).
   Remplace le TTL Firestore (pas besoin de Google Cloud Console).
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

exports.handler = async function () {
    try {
        init();
        var dbf = admin.firestore();
        var now = admin.firestore.Timestamp.now();
        var totalDeleted = 0;

        /* Supprime par lots de 400 (limite batch = 500), plusieurs passes par exécution */
        for (var pass = 0; pass < 10; pass++) {
            var snap = await dbf.collection("dmMessages")
                .where("expireAt", "<=", now)
                .limit(400)
                .get();
            if (snap.empty) break;
            var batch = dbf.batch();
            snap.forEach(function (doc) { batch.delete(doc.ref); });
            await batch.commit();
            totalDeleted += snap.size;
            if (snap.size < 400) break;
        }

        console.log("[DM-CLEANUP] messages supprimés:", totalDeleted);
        return { statusCode: 200, body: JSON.stringify({ deleted: totalDeleted }) };
    } catch (e) {
        console.error("[DM-CLEANUP]", e.message);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
