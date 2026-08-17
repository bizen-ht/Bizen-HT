/* ====================================
   BIZEN HT — Nettoyage des stories éphémères (24h)
   Fonction PLANIFIÉE (voir netlify.toml : schedule).
   Supprime les stories dont expiresAt <= maintenant ET leur photo dans Storage.
   ==================================== */
const admin = require('firebase-admin');

var STORAGE_BUCKET = "bizen-ht.firebasestorage.app";

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
        var bucket = admin.storage().bucket(STORAGE_BUCKET);
        var now = admin.firestore.Timestamp.now();
        var totalDeleted = 0, photosDeleted = 0;

        /* Plusieurs passes par exécution (lots de 300). */
        for (var pass = 0; pass < 10; pass++) {
            var snap = await dbf.collection("stories")
                .where("expiresAt", "<=", now)
                .limit(300)
                .get();
            if (snap.empty) break;

            /* 1) Supprime les photos Storage (best effort, en parallèle). */
            var photoJobs = [];
            snap.forEach(function (doc) {
                var s = doc.data();
                if (s.type === "photo" && s.storagePath) {
                    photoJobs.push(
                        bucket.file(s.storagePath).delete()
                            .then(function () { photosDeleted++; })
                            .catch(function () {})   /* fichier déjà absent : on ignore */
                    );
                }
            });
            await Promise.all(photoJobs);

            /* 2) Supprime les docs par batch. */
            var batch = dbf.batch();
            snap.forEach(function (doc) { batch.delete(doc.ref); });
            await batch.commit();
            totalDeleted += snap.size;
            if (snap.size < 300) break;
        }

        console.log("[STORY-CLEANUP] estòri:", totalDeleted, "| foto:", photosDeleted);
        return { statusCode: 200, body: JSON.stringify({ deleted: totalDeleted, photos: photosDeleted }) };
    } catch (e) {
        console.error("[STORY-CLEANUP]", e.message);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
