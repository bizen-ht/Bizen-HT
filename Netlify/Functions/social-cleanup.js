/* ====================================
   BIZEN SOCIAL — Nettoyage horaire (cron @hourly)
   - Supprime les messages éphémères expirés (socialMessages.expireAt < now)
   - Remet à plat les "Disponible maintenant" et "Boost" périmés
   Fonctionne sans requête entrante (déclenché par le planificateur Netlify).
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
        var nowTs = admin.firestore.Timestamp.now();
        var deleted = 0;

        /* 1) Messages éphémères expirés (par lots de 400). */
        while (true) {
            var snap = await dbf.collection("socialMessages")
                .where("expireAt", "<=", nowTs)
                .limit(400).get();
            if (snap.empty) break;
            var batch = dbf.batch();
            snap.forEach(function (d) { batch.delete(d.ref); deleted++; });
            await batch.commit();
            if (snap.size < 400) break;
        }

        /* 2) "Disponible maintenant" expiré (> 1h) : on enlève le drapeau. */
        var oneHourAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 3600 * 1000);
        var availSnap = await dbf.collection("socialProfiles")
            .where("availableNow", "<=", oneHourAgo).limit(300).get();
        if (!availSnap.empty) {
            var b2 = dbf.batch();
            availSnap.forEach(function (d) { b2.set(d.ref, { availableNow: null }, { merge: true }); });
            await b2.commit();
        }

        /* 3) Boosts expirés. */
        var boostSnap = await dbf.collection("socialProfiles")
            .where("boostUntil", "<=", nowTs).limit(300).get();
        if (!boostSnap.empty) {
            var b3 = dbf.batch();
            boostSnap.forEach(function (d) { b3.set(d.ref, { boostUntil: null }, { merge: true }); });
            await b3.commit();
        }

        console.log("[SOCIAL-CLEANUP] messages supprimés:", deleted);
        return { statusCode: 200, body: JSON.stringify({ deleted: deleted }) };
    } catch (e) {
        console.error("[SOCIAL-CLEANUP]", e.message);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
