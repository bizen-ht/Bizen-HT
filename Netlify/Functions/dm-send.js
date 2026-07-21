/* ====================================
   BIZEN HT — Messagerie de découverte (DM avant réservation)
   SEUL moyen d'envoyer un message (anti-triche côté serveur) :
   - vérifie les limites journalières (gratuit / premium)
   - filtre les contacts externes (tel, email, @user, whatsapp, telegram...)
   - écrit le message (éphémère 24h via expireAt) + met à jour le thread + le compteur
   Règles métier :
   - GRATUIT : 2 Élus max/jour, 5 messages max/jour (cumulés)
   - PREMIUM : 1 Élu/jour, messages illimités
   - L'Élu répond sans limite (mais ses messages sont aussi filtrés)
   - Compteurs remis à zéro à minuit (heure d'Haïti, UTC-5)
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

/* Date du jour à l'heure d'Haïti (UTC-5) au format YYYY-MM-DD */
function haitiDate() {
    return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/* Masque les coordonnées externes pour garder la conversation sur Bizen */
function filterContact(text) {
    var t = String(text == null ? "" : text);
    /* emails */
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, "•••");
    /* @usernames */
    t = t.replace(/(^|[\s.,!?])@\w{2,}/g, "$1•••");
    /* séquences de chiffres façon numéro de téléphone (5+ chiffres, séparateurs permis) */
    t = t.replace(/(\+?\d[\d\s().\-]{4,}\d)/g, "•••");
    /* mots-clés de plateformes externes */
    t = t.replace(/\b(whats?ap?p?|wsp|watsap|telegram|signal|viber|imo|snapchat|snap|instagram|insta|\big\b|tiktok|facebook|\bfb\b|messenger|gmail|hotmail|yahoo|outlook|e?-?mail|imel|nimewo|numero|num[ée]ro)\b/gi, "•••");
    return t;
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var eluUid = (body.eluUid || "").toString();
        var rawText = (body.text || "").toString();

        if (!idToken) return err(401, "idToken requis");
        if (!eluUid) return err(400, "eluUid requis");
        var text = rawText.trim().slice(0, 1000);

        /* Média (photo/vidéo) envoyé par le CLIENT — l'URL vient de Firebase Storage */
        var mediaUrl = (body.mediaUrl || "").toString().slice(0, 600);
        var mediaType = (body.mediaType === "video") ? "video" : (body.mediaType === "image" ? "image" : "");
        if (mediaUrl && mediaUrl.indexOf("https://") !== 0) return err(400, "Medya pa valab.");
        if (!mediaUrl) mediaType = "";

        if (!text && !mediaUrl) return err(400, "Mesaj vid.");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var senderUid = decoded.uid;
        /* ADMIN : peut répondre AU NOM d'un Élu (gestion des comptes test).
           asEluUid = l'Élu impersonné ; eluUid = le destinataire (le client). */
        var ADMIN_EMAIL = "bizenht@gmail.com";
        if (decoded.email === ADMIN_EMAIL && body.asEluUid) {
            senderUid = body.asEluUid.toString();
        }
        if (senderUid === eluUid) return err(400, "Ou pa ka voye mesaj ba tèt ou.");

        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var now = Date.now();
        var nowTs = admin.firestore.Timestamp.fromMillis(now);
        var expireTs = admin.firestore.Timestamp.fromMillis(now + 24 * 3600 * 1000);

        /* Thread déterministe : 1 fil par paire (client <-> Élu) */
        var pair = [senderUid, eluUid].sort();
        var threadId = pair[0] + "_" + pair[1];
        var threadRef = dbf.collection("dmThreads").doc(threadId);
        var threadSnap = await threadRef.get();
        var thread = threadSnap.exists ? threadSnap.data() : null;

        /* Détermine qui est le client et qui est l'Élu dans ce fil */
        var isEluReply = !!(thread && thread.eluUid === senderUid);

        var senderDoc = await dbf.collection("users").doc(senderUid).get();
        var sender = senderDoc.exists ? senderDoc.data() : {};
        var senderName = sender.pseudo || sender.prenom || "Itilizatè";
        var isPremium = sender.isPremium === true;

        /* ---- VÉRIFICATION DES LIMITES (seulement pour le CLIENT, pas l'Élu) ---- */
        var counterRef = null;
        var counter = null;
        if (!isEluReply) {
            var dstr = haitiDate();
            counterRef = dbf.collection("dmCounters").doc(senderUid + "_" + dstr);
            var cSnap = await counterRef.get();
            counter = cSnap.exists ? cSnap.data() : { people: [], count: 0, date: dstr };
            var people = counter.people || [];
            var alreadyTalking = people.indexOf(eluUid) !== -1;
            var maxPeople = isPremium ? 3 : 2;
            var maxMessages = isPremium ? Infinity : 5;

            if (!alreadyTalking && people.length >= maxPeople) {
                return err(429, isPremium
                    ? "Kòm Premium ou ka pale ak 3 moun pa jou (mesaj san limit). Retounen demen pou yon lòt."
                    : "Ou rive nan limit 2 moun pa jou a. Vin Premium pou plis, oswa tann demen.",
                    { reason: "people", premiumInvite: !isPremium });
            }
            if (counter.count >= maxMessages) {
                return err(429,
                    "Ou voye 5 mesaj jodi a (limit gratis la). Vin Premium pou mesaj san limit, oswa tann demen.",
                    { reason: "messages", premiumInvite: true });
            }
        }

        /* ---- ÉCRITURE DU MESSAGE (filtré, éphémère 24h) ---- */
        var receiverUid = isEluReply ? thread.userUid : eluUid;
        var filtered = filterContact(text);

        /* Seul le CLIENT peut envoyer un média (pas l'Élu / pas l'admin-pour-Élu) */
        var okMedia = (!isEluReply && mediaUrl) ? mediaUrl : "";
        var okMediaType = okMedia ? mediaType : "";

        await dbf.collection("dmMessages").add({
            threadId: threadId,
            participants: pair,
            senderId: senderUid,
            receiverId: receiverUid,
            text: filtered,
            mediaUrl: okMedia,
            mediaType: okMediaType,
            createdAt: nowTs,
            expireAt: expireTs           /* TTL Firestore supprime ~24h après */
        });

        /* ---- MISE À JOUR DU THREAD ---- */
        var lastPreview = filtered ? filtered.slice(0, 120)
            : (okMediaType === "video" ? "🎥 Videyo" : "📷 Foto");
        var threadUpdate = {
            participants: pair,
            lastMessage: lastPreview,
            lastAt: nowTs,
            updatedAt: nowTs
        };
        if (!threadSnap.exists) {
            /* Création : l'initiateur est le client, la cible est l'Élu */
            var eluDoc = await dbf.collection("publicProfiles").doc(eluUid).get();
            var elu = eluDoc.exists ? eluDoc.data() : {};
            threadUpdate.userUid = senderUid;
            threadUpdate.eluUid = eluUid;
            threadUpdate.userName = senderName;
            threadUpdate.eluName = elu.pseudo || elu.prenom || "Elu";
            threadUpdate.userIsPremium = isPremium;       /* tri prioritaire côté Élu */
            threadUpdate.createdAt = nowTs;
        }
        /* Compteurs de non-lus pour la bonne personne */
        if (isEluReply) {
            threadUpdate.unreadForUser = FieldValue.increment(1);
        } else {
            threadUpdate.unreadForElu = FieldValue.increment(1);
            threadUpdate.userIsPremium = isPremium;        /* re-confirme le statut premium */
        }
        await threadRef.set(threadUpdate, { merge: true });

        /* ---- MISE À JOUR DU COMPTEUR (client uniquement) ---- */
        var remaining = null;
        if (!isEluReply && counterRef) {
            var people2 = counter.people || [];
            if (people2.indexOf(eluUid) === -1) people2.push(eluUid);
            var newCount = (counter.count || 0) + 1;
            await counterRef.set({
                people: people2, count: newCount, date: counter.date,
                updatedAt: nowTs
            }, { merge: true });
            remaining = {
                isPremium: isPremium,
                peopleUsed: people2.length,
                peopleMax: isPremium ? 3 : 2,
                messagesUsed: newCount,
                messagesMax: isPremium ? null : 5
            };
        }

        /* ---- MESSAGE D'ACCUEIL AUTOMATIQUE DE L'ÉLU ----
           Envoyé UNE SEULE FOIS : au tout premier message d'un client dans ce fil.
           Les messages suivants attendent la vraie réponse de l'Élu. */
        if (!isEluReply && !threadSnap.exists) {
            try {
                var eluUserDoc = await dbf.collection("users").doc(eluUid).get();
                var welcome = eluUserDoc.exists ? (eluUserDoc.data().welcomeMessage || "") : "";
                welcome = welcome.toString().trim().slice(0, 300);
                if (welcome) {
                    var wTs = admin.firestore.Timestamp.fromMillis(now + 1000);
                    await dbf.collection("dmMessages").add({
                        threadId: threadId,
                        participants: pair,
                        senderId: eluUid,          /* le message vient de l'Élu */
                        receiverId: senderUid,
                        text: filterContact(welcome),
                        mediaUrl: "", mediaType: "",
                        isAuto: true,              /* marqué comme réponse automatique */
                        createdAt: wTs,
                        expireAt: admin.firestore.Timestamp.fromMillis(now + 24 * 3600 * 1000)
                    });
                    /* Objet SÉPARÉ : ne pas réutiliser threadUpdate (il contient
                       unreadForElu: increment(1) => ça compterait 2 fois). */
                    await threadRef.set({
                        lastMessage: filterContact(welcome).slice(0, 120),
                        lastAt: wTs,
                        updatedAt: wTs,
                        autoWelcomeSent: true,
                        unreadForUser: FieldValue.increment(1)
                    }, { merge: true });
                }
            } catch (e) { console.warn("[DM-SEND] welcome:", e.message); }
        }

        /* ---- NOTIF PUSH au destinataire (best effort) ---- */
        try {
            var rcvDoc = await dbf.collection("users").doc(receiverUid).get();
            var tokens = (rcvDoc.exists && rcvDoc.data().fcmTokens) || [];
            if (tokens.length) {
                await admin.messaging().sendEachForMulticast({
                    tokens: tokens,
                    notification: { title: "Nouvo mesaj sou Bizen HT", body: "Ou gen yon nouvo mesaj." },
                    data: { link: "/Dashboard.html" }
                });
            }
        } catch (e) { /* ignore */ }

        return ok({ success: true, threadId: threadId, remaining: remaining });
    } catch (e) {
        console.error("[DM-SEND]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
