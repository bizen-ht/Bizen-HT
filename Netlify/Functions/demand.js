/* ====================================
   BIZEN HT — "Post yon demann" (marketplace inversée)
   Un VIP PREMIUM publie une demande ciblée par zone ("je cherche…").
   Les Elus de la zone la voient dans leur dashboard et répondent en DM privé.

   Actions (toutes via Admin SDK, auth par idToken) :
   - post   : le VIP publie (Premium requis, texte filtré anti-contact,
              1 demande active à la fois, expiration 48h).
   - reply  : une Elu répond -> crée le fil DM Elu→VIP (bons rôles) + 1er message.
   - close  : le VIP ferme sa demande.

   Le vrai nom du VIP n'est JAMAIS exposé : on utilise son pseudo.
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
function err(c, m, extra) { return { statusCode: c, headers: CORS, body: JSON.stringify(Object.assign({ error: m }, extra || {})) }; }

var DEMAND_TTL_MS = 48 * 3600 * 1000;   /* une demande vit 48h */

/* Masque les coordonnées externes (tel, email, @user, plateformes) — même
   logique que dm-send : la conversation doit rester sur Bizen. */
function filterContact(text) {
    var t = String(text == null ? "" : text);
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, "•••");
    t = t.replace(/(^|[\s.,!?])@\w{2,}/g, "$1•••");
    t = t.replace(/(\+?\d[\d\s().\-]{4,}\d)/g, "•••");
    t = t.replace(/\b(whats?ap?p?|wsp|watsap|telegram|signal|viber|imo|snapchat|snap|instagram|insta|\big\b|tiktok|facebook|\bfb\b|messenger|gmail|hotmail|yahoo|outlook|e?-?mail|imel|nimewo|numero|num[ée]ro)\b/gi, "•••");
    return t;
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        if (!body.idToken) return err(401, "idToken requis");
        var action = (body.action || "").toString();

        var decoded = await admin.auth().verifyIdToken(body.idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var now = Date.now();
        var nowTs = admin.firestore.Timestamp.fromMillis(now);

        /* ---------- 1) PUBLIER UNE DEMANDE (VIP Premium) ---------- */
        if (action === "post") {
            var zone = (body.zone || "").toString().trim().slice(0, 60);
            var lookingFor = (body.lookingFor === "gason") ? "gason" : (body.lookingFor === "fanm" ? "fanm" : "tou");
            var rawText = (body.text || "").toString().trim().slice(0, 300);
            if (!zone) return err(400, "Chwazi yon zòn.");
            if (!rawText) return err(400, "Ekri sa w ap chèche.");

            var uSnap = await dbf.collection("users").doc(uid).get();
            if (!uSnap.exists) return err(404, "Kont pa jwenn.");
            var u = uSnap.data();
            if (u.type && u.type !== "user") return err(403, "Sèlman VIP ka poste yon demann.");
            if (u.isPremium !== true) return err(403, "Se yon fonksyon Premium. Vin Premium pou poste yon demann.", { premiumInvite: true });

            var text = filterContact(rawText);
            var pseudo = (u.pseudo || u.prenom || "VIP").toString().slice(0, 30);

            /* 1 seule demande active : on ferme les anciennes avant de créer. */
            var actives = await dbf.collection("vipDemands")
                .where("vipUid", "==", uid).where("status", "==", "active").get();
            var closeBatch = dbf.batch();
            actives.forEach(function (d) { closeBatch.update(d.ref, { status: "closed", closedAt: nowTs }); });
            if (!actives.empty) await closeBatch.commit();

            var ref = await dbf.collection("vipDemands").add({
                vipUid: uid,
                vipPseudo: pseudo,
                zone: zone,
                lookingFor: lookingFor,       /* fanm | gason | tou */
                text: text,
                status: "active",
                replyCount: 0,
                repliedBy: [],
                createdAt: nowTs,
                expiresAt: admin.firestore.Timestamp.fromMillis(now + DEMAND_TTL_MS)
            });

            /* ---- NOTIF PUSH aux Elus de la ZONE (best effort) ----
               On cible les Elus ACTIFS dont une zone (zones[] / localisation /
               kreyZone) correspond, en respectant la préférence de genre. Le clic
               atterrit direct sur la demande (Dashboard.html?demann=<id>). */
            try {
                var zoneLc = zone.toLowerCase();
                var pcSnap = await dbf.collection("publicProfiles").where("status", "==", "active").get();
                var targetUids = [];
                pcSnap.forEach(function (d) {
                    var p = d.data();
                    var isFanm = !(p.genre === "homme" || p.genre === "gason");
                    if (lookingFor === "fanm" && !isFanm) return;
                    if (lookingFor === "gason" && isFanm) return;
                    var zs = {};
                    (p.zones || []).forEach(function (z) { if (z) zs[String(z).toLowerCase().trim()] = 1; });
                    if (p.localisation) zs[String(p.localisation).toLowerCase().trim()] = 1;
                    if (p.kreyZone) zs[String(p.kreyZone).toLowerCase().trim()] = 1;
                    if (zs[zoneLc]) targetUids.push(d.id);
                });

                if (targetUids.length) {
                    /* Récupère les jetons FCM (sur users) par lots de 30 (getAll). */
                    var tokens = [];
                    for (var i = 0; i < targetUids.length; i += 30) {
                        var refs = targetUids.slice(i, i + 30).map(function (id) { return dbf.collection("users").doc(id); });
                        var udocs = await dbf.getAll.apply(dbf, refs);
                        udocs.forEach(function (ud) {
                            if (ud.exists) (ud.data().fcmTokens || []).forEach(function (t) { if (t) tokens.push(t); });
                        });
                    }
                    if (tokens.length) {
                        var link = "/Dashboard.html?demann=" + ref.id;
                        var body2 = (text.length > 90 ? text.slice(0, 90) + "…" : text);
                        for (var j = 0; j < tokens.length; j += 500) {
                            await admin.messaging().sendEachForMulticast({
                                tokens: tokens.slice(j, j + 500),
                                notification: { title: "Nouvo demann nan " + zone + " 📢", body: body2 },
                                data: { link: link },
                                webpush: { fcmOptions: { link: link } }
                            });
                        }
                    }
                }
            } catch (e) { console.warn("[DEMAND] notify:", e.message); }

            return ok({ success: true, id: ref.id });
        }

        /* ---------- 2) FERMER SA DEMANDE (VIP) ---------- */
        if (action === "close") {
            var did = (body.demandId || "").toString();
            if (!did) return err(400, "demandId requis");
            var dRef = dbf.collection("vipDemands").doc(did);
            var dSnap = await dRef.get();
            if (!dSnap.exists) return err(404, "Demann pa jwenn.");
            if (dSnap.data().vipUid !== uid) return err(403, "Se pa demann ou.");
            await dRef.update({ status: "closed", closedAt: nowTs });
            return ok({ success: true });
        }

        /* ---------- 3) RÉPONDRE À UNE DEMANDE (Elu → VIP en privé) ---------- */
        if (action === "reply") {
            var demandId = (body.demandId || "").toString();
            if (!demandId) return err(400, "demandId requis");

            /* L'expéditeur doit être une Elu (freelancer/krey) active. */
            var eluSnap = await dbf.collection("users").doc(uid).get();
            if (!eluSnap.exists) return err(404, "Kont pa jwenn.");
            var elu = eluSnap.data();
            if (elu.type !== "freelancer" && elu.type !== "krey") return err(403, "Sèlman Elu ka reponn yon demann.");
            if (elu.status && elu.status !== "active") return err(403, "Kont ou poko aktif.");

            var demRef = dbf.collection("vipDemands").doc(demandId);
            var demSnap = await demRef.get();
            if (!demSnap.exists) return err(404, "Demann pa jwenn.");
            var dem = demSnap.data();
            if (dem.status !== "active" || (dem.expiresAt && dem.expiresAt.toMillis && dem.expiresAt.toMillis() < now)) {
                return err(410, "Demann sa a pa aktif ankò.");
            }
            var vipUid = dem.vipUid;
            if (vipUid === uid) return err(400, "Ou pa ka reponn pwòp demann ou.");
            if ((dem.repliedBy || []).indexOf(uid) !== -1) return err(409, "Ou deja reponn demann sa a.");

            /* Message d'ouverture (filtré). L'Elu peut ajouter une note courte. */
            var note = (body.text || "").toString().trim().slice(0, 500);
            var eluName = elu.pseudo || elu.prenom || "Elu";
            var openText = filterContact(note || ("Bonjou! Mwen wè demann ou nan " + (dem.zone || "zòn ou") + ". Mwen enterese, ann pale."));

            /* Fil DM déterministe (1 par paire) — rôles : userUid = VIP, eluUid = Elu. */
            var pair = [uid, vipUid].sort();
            var threadId = pair[0] + "_" + pair[1];
            var threadRef = dbf.collection("dmThreads").doc(threadId);
            var threadSnap = await threadRef.get();
            var thread = threadSnap.exists ? threadSnap.data() : null;
            var isEphemeral = !(thread && thread.ephemeral === false);

            /* VIP (destinataire) : nom = pseudo. */
            var vipDoc = await dbf.collection("users").doc(vipUid).get();
            var vip = vipDoc.exists ? vipDoc.data() : {};
            var vipName = vip.pseudo || vip.prenom || "VIP";

            var msgDoc = {
                threadId: threadId,
                participants: pair,
                senderId: uid,            /* l'Elu envoie */
                receiverId: vipUid,
                text: openText,
                mediaUrl: "", mediaType: "",
                demandId: demandId,
                createdAt: nowTs
            };
            if (isEphemeral) msgDoc.expireAt = admin.firestore.Timestamp.fromMillis(now + 24 * 3600 * 1000);
            await dbf.collection("dmMessages").add(msgDoc);

            var threadUpdate = {
                participants: pair,
                lastMessage: openText.slice(0, 120),
                lastAt: nowTs,
                updatedAt: nowTs,
                unreadForUser: FieldValue.increment(1)   /* le VIP a un non-lu */
            };
            if (!threadSnap.exists) {
                threadUpdate.userUid = vipUid;
                threadUpdate.eluUid = uid;
                threadUpdate.userName = vipName;
                threadUpdate.eluName = eluName;
                threadUpdate.userIsPremium = (vip.isPremium === true);
                threadUpdate.createdAt = nowTs;
            }
            await threadRef.set(threadUpdate, { merge: true });

            /* Marque l'Elu comme ayant répondu (anti-doublon) + compteur. */
            await demRef.update({
                repliedBy: FieldValue.arrayUnion(uid),
                replyCount: FieldValue.increment(1)
            });

            /* Push au VIP (best effort). */
            try {
                var tokens = (vip.fcmTokens || []);
                if (tokens.length) {
                    await admin.messaging().sendEachForMulticast({
                        tokens: tokens,
                        notification: { title: eluName + " reponn demann ou 💌", body: openText.slice(0, 100) },
                        data: { link: "/Dashboard.html" },
                        webpush: { fcmOptions: { link: "/Dashboard.html" } }
                    });
                }
            } catch (e) { /* ignore */ }

            return ok({ success: true, threadId: threadId });
        }

        return err(400, "Aksyon enkoni.");
    } catch (e) {
        console.error("[DEMAND]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
