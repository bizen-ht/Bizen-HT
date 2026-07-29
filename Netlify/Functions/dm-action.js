/* ====================================
   BIZEN HT — Actions sur la messagerie (DM)
   Deux actions, toutes deux passant par le serveur (Admin SDK) car le client
   ne peut pas écrire dans dmMessages/dmThreads :

   1) toggleEphemeral : active/désactive le mode éphémère d'une conversation.
      - ephemeral=true  -> les messages s'effacent 24h après l'envoi (expireAt)
      - ephemeral=false -> conversation PERMANENTE (on retire expireAt)
      Met aussi à jour les messages DÉJÀ présents dans le fil.

   2) deleteMessage : « efase pou tout moun » — l'auteur (ou admin / boss du
      Elu) remplace son message par un « message effacé » (tombstone).

   Autorisation : participant du fil (pour le toggle), auteur du message
   (pour la suppression), ou admin, ou Boss propriétaire de l'Élu concerné.
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

var ADMIN_EMAIL = "bizenht@gmail.com";

/* Vrai si `uid` est le Boss propriétaire de l'Élu `eluUid`. */
async function isBossOfElu(dbf, uid, eluUid) {
    if (!uid || !eluUid) return false;
    try {
        var d = await dbf.collection("users").doc(eluUid).get();
        return d.exists && d.data().bossId === uid;
    } catch (e) { return false; }
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var action = (body.action || "").toString();
        if (!idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var isAdmin = decoded.email === ADMIN_EMAIL;
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;

        /* ---------- 1) ACTIVER / DÉSACTIVER L'ÉPHÉMÈRE ---------- */
        if (action === "toggleEphemeral") {
            var threadId = (body.threadId || "").toString();
            var ephemeral = !!body.ephemeral;
            if (!threadId) return err(400, "threadId requis");

            var tRef = dbf.collection("dmThreads").doc(threadId);
            var tSnap = await tRef.get();
            if (!tSnap.exists) return err(404, "Konvèsasyon pa jwenn.");
            var t = tSnap.data();
            var parts = t.participants || [];
            var allowed = isAdmin || parts.indexOf(uid) !== -1 || await isBossOfElu(dbf, uid, t.eluUid);
            if (!allowed) return err(403, "Ou pa ka chanje konvèsasyon sa a.");

            await tRef.set({ ephemeral: ephemeral, ephemeralUpdatedAt: admin.firestore.Timestamp.now() }, { merge: true });

            /* Applique aussi aux messages déjà présents dans le fil. */
            var now = Date.now();
            var newExpire = admin.firestore.Timestamp.fromMillis(now + 24 * 3600 * 1000);
            var msgsSnap = await dbf.collection("dmMessages").where("threadId", "==", threadId).get();
            var docs = [];
            msgsSnap.forEach(function (d) { docs.push(d.ref); });
            for (var i = 0; i < docs.length; i += 400) {
                var batch = dbf.batch();
                var slice = docs.slice(i, i + 400);
                slice.forEach(function (ref) {
                    batch.update(ref, { expireAt: ephemeral ? newExpire : FieldValue.delete() });
                });
                await batch.commit();
            }
            return ok({ success: true, ephemeral: ephemeral });
        }

        /* ---------- 2) EFFACER UN MESSAGE POUR TOUT LE MONDE ---------- */
        if (action === "deleteMessage") {
            var messageId = (body.messageId || "").toString();
            if (!messageId) return err(400, "messageId requis");

            var mRef = dbf.collection("dmMessages").doc(messageId);
            var mSnap = await mRef.get();
            if (!mSnap.exists) return err(404, "Mesaj pa jwenn.");
            var m = mSnap.data();

            var allowed2 = isAdmin || m.senderId === uid || await isBossOfElu(dbf, uid, m.senderId);
            if (!allowed2) return err(403, "Ou ka efase sèlman pwòp mesaj ou.");

            await mRef.set({
                deleted: true,
                text: "",
                mediaUrl: "",
                mediaType: "",
                deletedAt: admin.firestore.Timestamp.now()
            }, { merge: true });

            /* Rafraîchit l'aperçu du fil si le message effacé était le dernier. */
            try {
                var tid = m.threadId;
                if (tid) {
                    var allSnap = await dbf.collection("dmMessages").where("threadId", "==", tid).get();
                    var latest = null;
                    allSnap.forEach(function (d) {
                        var x = d.data();
                        var ms = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
                        if (!latest || ms > latest.ms) latest = { ms: ms, data: x };
                    });
                    if (latest) {
                        var preview = latest.data.deleted
                            ? "🚫 Mesaj efase"
                            : (latest.data.text
                                ? latest.data.text.slice(0, 120)
                                : (latest.data.mediaType === "video" ? "🎥 Videyo" : (latest.data.mediaType === "image" ? "📷 Foto" : "")));
                        await dbf.collection("dmThreads").doc(tid).set({ lastMessage: preview }, { merge: true });
                    }
                }
            } catch (e) { /* aperçu best-effort */ }

            return ok({ success: true });
        }

        return err(400, "Aksyon enkoni.");
    } catch (e) {
        console.error("[DM-ACTION]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
