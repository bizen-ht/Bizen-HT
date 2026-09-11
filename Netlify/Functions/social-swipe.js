/* ====================================
   BIZEN SOCIAL — Swipe (like / pass / super) + détection de MATCH
   SEUL moyen d'écrire un swipe (anti-triche côté serveur) :
   - vérifie les limites journalières (gratuit / premium)
   - écrit le swipe (id déterministe {from}_{to} => pas de doublon)
   - si like/super : ajoute une entrée "like reçu" chez la cible
   - teste la réciprocité ; si like mutuel => crée le MATCH + push aux deux
   Règles freemium :
   - GRATUIT : 30 swipes/jour ; Super Like consomme un crédit
   - PREMIUM : swipes illimités
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

function haitiDate() {
    return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

var FREE_SWIPES_PER_DAY = 30;
/* PHASE 1 = tout gratuit (attirer les utilisateurs). Mettre false plus tard
   pour reactiver le modele freemium (limites + Premium). */
var PHASE_ALL_FREE = true;

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var targetUid = (body.targetUid || "").toString();
        var dir = body.dir;   /* "like" | "pass" | "super" */

        if (!idToken) return err(401, "idToken requis");
        if (!targetUid) return err(400, "targetUid requis");
        if (["like", "pass", "super"].indexOf(dir) === -1) return err(400, "dir envalid");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        if (uid === targetUid) return err(400, "Ou pa ka swipe tèt ou.");

        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var nowTs = admin.firestore.Timestamp.now();

        /* Mon profil doit exister et être actif. */
        var meSnap = await dbf.collection("socialProfiles").doc(uid).get();
        if (!meSnap.exists) return err(404, "Ou poko gen yon pwofil Bizen Social.");
        if (meSnap.data().status === "banned") return err(403, "Kont Social ou sispann.");

        /* Droits (premium / crédits super like). */
        var entSnap = await dbf.collection("socialEntitlements").doc(uid).get();
        var ent = entSnap.exists ? entSnap.data() : {};
        var isPremium = ent.premiumUntil && ent.premiumUntil.toMillis && ent.premiumUntil.toMillis() > Date.now();

        /* Super Like : nécessite un crédit (sauf premium). Desactive en Phase 1. */
        if (!PHASE_ALL_FREE && dir === "super") {
            var credits = ent.superCredits || 0;
            if (credits < 1) return err(429, "Ou pa gen Super Like disponib. Achte yon pak.", { reason: "super" });
        }

        /* ---- LIMITE DE SWIPES : vérif + réservation ATOMIQUE (gratuit) ---- */
        if (!PHASE_ALL_FREE && !isPremium && dir !== "pass") {   /* les "pass" ne comptent pas dans la limite */
            var dstr = haitiDate();
            var counterRef = dbf.collection("socialCounters").doc(uid + "_" + dstr);
            var limit;
            try {
                limit = await dbf.runTransaction(async function (t) {
                    var cSnap = await t.get(counterRef);
                    var c = cSnap.exists ? cSnap.data() : { swipes: 0, date: dstr };
                    var used = c.swipes || 0;
                    if (used >= FREE_SWIPES_PER_DAY) return { blocked: true };
                    t.set(counterRef, { swipes: used + 1, date: dstr, updatedAt: nowTs }, { merge: true });
                    return { used: used + 1 };
                });
            } catch (e) {
                console.error("[SOCIAL-SWIPE] counter tx:", e.message);
                return err(500, "Erè kontè. Eseye ankò.");
            }
            if (limit.blocked) {
                return err(429,
                    "Ou rive nan limit " + FREE_SWIPES_PER_DAY + " swipe pa jou a. Vin Premium pou swipe san limit, oswa tann demen.",
                    { reason: "swipes", premiumInvite: true });
            }
        }

        /* ---- ÉCRITURE DU SWIPE (id déterministe => pas de doublon) ---- */
        var swipeRef = dbf.collection("socialSwipes").doc(uid + "_" + targetUid);
        await swipeRef.set({ from: uid, to: targetUid, dir: dir, createdAt: nowTs }, { merge: true });

        /* Consomme le crédit Super Like APRÈS écriture réussie (sauf Phase 1 gratuite). */
        if (!PHASE_ALL_FREE && dir === "super") {
            try { await entSnap.ref.set({ superCredits: FieldValue.increment(-1) }, { merge: true }); } catch (e) {}
        }

        /* Un "pass" s'arrête là : pas de like reçu, pas de match. */
        if (dir === "pass") return ok({ success: true, match: false });

        /* ---- LIKE REÇU chez la cible (révélé si la cible est Premium) ---- */
        try {
            await dbf.collection("socialLikesReceived").doc(targetUid + "_" + uid).set({
                owner: targetUid, fromUid: uid, super: dir === "super", createdAt: nowTs
            }, { merge: true });
        } catch (e) {}

        /* ---- TEST DE RÉCIPROCITÉ ---- */
        var reverse = await dbf.collection("socialSwipes").doc(targetUid + "_" + uid).get();
        var theyLike = reverse.exists && (reverse.data().dir === "like" || reverse.data().dir === "super");
        if (!theyLike) return ok({ success: true, match: false });

        /* ---- MATCH ! Crée le doc match (id de paire déterministe) ---- */
        var pair = [uid, targetUid].sort();
        var pairId = pair[0] + "_" + pair[1];
        var matchRef = dbf.collection("socialMatches").doc(pairId);
        var existingMatch = await matchRef.get();
        if (!existingMatch.exists) {
            var theirSnap = await dbf.collection("socialProfiles").doc(targetUid).get();
            var their = theirSnap.exists ? theirSnap.data() : {};
            var me = meSnap.data();
            /* Noms/photos figés dans le match pour un affichage rapide côté client. */
            var names = {}; names[uid] = me.pseudo || "Anonim"; names[targetUid] = their.pseudo || "Anonim";
            var avatars = {};
            avatars[uid] = (me.photos && me.photos[0]) || "";
            avatars[targetUid] = (their.photos && their.photos[0]) || "";
            await matchRef.set({
                users: pair,
                names: names,
                avatars: avatars,
                createdAt: nowTs,
                lastMessage: "",
                lastAt: nowTs,
                ephemeral: true,               /* messages éphémères ON par défaut */
                unread: { }                    /* incrémenté par socialMessages */
            }, { merge: true });

            /* Push aux DEUX (best effort) : "Nouvo match !" */
            try {
                var pushOne = async function (toUid, otherName) {
                    var uDoc = await dbf.collection("users").doc(toUid).get();
                    var tokens = (uDoc.exists && uDoc.data().fcmTokens) || [];
                    if (tokens.length) {
                        await admin.messaging().sendEachForMulticast({
                            tokens: tokens,
                            notification: { title: "💗 Nouvo match sou Bizen Social!", body: "Ou ak " + otherName + " like youn lòt. Kòmanse pale!" },
                            data: { link: "/social.html#matches" }
                        });
                    }
                };
                await pushOne(uid, names[targetUid]);
                await pushOne(targetUid, names[uid]);
            } catch (e) {}
        }

        return ok({ success: true, match: true, pairId: pairId });
    } catch (e) {
        console.error("[SOCIAL-SWIPE]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
