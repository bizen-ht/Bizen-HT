/* ====================================
   BIZEN HT — Fin de suspension automatique (alertes)
   Fonction PLANIFIÉE (voir netlify.toml : schedule).
   Retablit les Elus dont la suspension (suspendReason "alert") est terminée :
   status "frozen" + suspendedUntil <= maintenant  ->  status "active".
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
        var FieldValue = admin.firestore.FieldValue;
        var now = admin.firestore.Timestamp.now();

        /* Docs dont la suspension est arrivée à échéance (single-field range index auto). */
        var snap = await dbf.collection("users").where("suspendedUntil", "<=", now).get();
        var restored = 0;

        var jobs = [];
        snap.forEach(function (doc) {
            var d = doc.data();
            /* Seulement les suspensions "alerte" encore gelées : on ne touche pas
               un compte gelé manuellement pour une autre raison. */
            if (d.status !== "frozen" || d.suspendReason !== "alert") return;
            restored++;
            jobs.push(doc.ref.update({
                status: "active",
                suspendedUntil: FieldValue.delete(),
                suspendReason: FieldValue.delete()
            }));
            jobs.push(dbf.collection("publicProfiles").doc(doc.id)
                .set({ status: "active" }, { merge: true }).catch(function () {}));
        });
        await Promise.all(jobs);

        console.log("[UNSUSPEND] retabli:", restored);
        return { statusCode: 200, body: JSON.stringify({ restored: restored }) };
    } catch (e) {
        console.error("[UNSUSPEND]", e.message);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
