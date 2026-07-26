/* ====================================
   BIZEN HT — Gestion Boss (Phase 2)
   Le Boss (DG d'une agence / gwoup) gère SES membres (Elu ou Krey) :
   - jele / retabli yon kont (freeze / unfreeze)
   - efase yon kont (delete : Auth + users + publicProfiles)
   - li mesaj yon Elu (threads / messages) pou reponn nan plas li

   SÉCURITÉ : tout passe par l'Admin SDK. On vérifie TOUJOURS que le membre
   ciblé a bien bossId == uid de l'appelant (ou que l'appelant est l'admin).
   Le client ne peut donc jamais toucher un compte qui n'est pas sous son Boss.
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

var ADMIN_EMAIL = "bizenht@gmail.com";

var CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};
function ok(b)  { return { statusCode: 200, headers: CORS, body: JSON.stringify(b) }; }
function err(c, m) { return { statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) }; }

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = (body.idToken || "").toString();
        var action = (body.action || "").toString();
        var memberId = (body.memberId || "").toString();

        if (!idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var callerUid = decoded.uid;
        var isAdmin = (decoded.email === ADMIN_EMAIL);

        var dbf = admin.firestore();

        /* --- Vérifie que le membre ciblé appartient bien à l'appelant --- */
        async function requireOwned(id) {
            if (!id) throw { code: 400, msg: "memberId requis" };
            var snap = await dbf.collection("users").doc(id).get();
            if (!snap.exists) throw { code: 404, msg: "Manm pa egziste." };
            var m = snap.data();
            if (!isAdmin && m.bossId !== callerUid) throw { code: 403, msg: "Manm sa a pa anba ou." };
            return m;
        }

        if (action === "freeze" || action === "unfreeze") {
            await requireOwned(memberId);
            var newStatus = (action === "freeze") ? "frozen" : "active";
            await dbf.collection("users").doc(memberId).set({ status: newStatus }, { merge: true });
            await dbf.collection("publicProfiles").doc(memberId).set({ status: newStatus }, { merge: true }).catch(function(){});
            return ok({ success: true, status: newStatus });
        }

        if (action === "delete") {
            await requireOwned(memberId);
            /* Supprime le compte Auth (best effort), puis les docs Firestore. */
            try { await admin.auth().deleteUser(memberId); } catch (e) { /* déjà supprimé / inexistant */ }
            await dbf.collection("users").doc(memberId).delete().catch(function(){});
            await dbf.collection("publicProfiles").doc(memberId).delete().catch(function(){});
            return ok({ success: true, deleted: true });
        }

        /* Liste des fils de discussion d'un Elu (pour que le Boss réponde). */
        if (action === "threads") {
            await requireOwned(memberId);
            var tSnap = await dbf.collection("dmThreads")
                .where("eluUid", "==", memberId)
                .get();
            var threads = [];
            tSnap.forEach(function (d) {
                var t = d.data();
                threads.push({
                    id: d.id,
                    userUid: t.userUid || "",
                    userName: t.userName || "Kliyan",
                    userIsPremium: !!t.userIsPremium,
                    lastMessage: t.lastMessage || "",
                    lastAt: t.lastAt ? t.lastAt.toMillis() : 0,
                    unreadForElu: t.unreadForElu || 0
                });
            });
            threads.sort(function (a, b) { return b.lastAt - a.lastAt; });
            return ok({ success: true, threads: threads });
        }

        /* Messages d'un fil (le Boss doit posséder l'Elu du fil). */
        if (action === "messages") {
            var threadId = (body.threadId || "").toString();
            if (!threadId) return err(400, "threadId requis");
            var thRef = await dbf.collection("dmThreads").doc(threadId).get();
            if (!thRef.exists) return err(404, "Fil pa egziste.");
            var th = thRef.data();
            await requireOwned(th.eluUid || "");   /* l'Elu du fil doit être sous ce Boss */
            var mSnap = await dbf.collection("dmMessages")
                .where("threadId", "==", threadId)
                .get();
            var msgs = [];
            mSnap.forEach(function (d) {
                var m = d.data();
                msgs.push({
                    id: d.id,
                    senderId: m.senderId || "",
                    text: m.text || "",
                    mediaUrl: m.mediaUrl || "",
                    mediaType: m.mediaType || "",
                    createdAt: m.createdAt ? m.createdAt.toMillis() : 0
                });
            });
            msgs.sort(function (a, b) { return a.createdAt - b.createdAt; });
            /* Remet à zéro le compteur non-lus côté Elu (le Boss vient de lire). */
            await dbf.collection("dmThreads").doc(threadId).set({ unreadForElu: 0 }, { merge: true }).catch(function(){});
            return ok({ success: true, messages: msgs });
        }

        return err(400, "Action pa rekonèt.");
    } catch (e) {
        if (e && e.code && e.msg) return err(e.code, e.msg);
        console.error("[BOSS]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
