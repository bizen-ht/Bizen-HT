/* ====================================
   BIZEN SOCIAL — Activation du profil de rencontre (1 clic)
   Le membre Bizen (VIP/Élu) existe déjà (users/{uid}). Ici on NE crée
   PAS de compte : on pose un profil Social lié au même uid.
   - Vérifie le token Firebase (identité)
   - Vérifie l'âge (18+) et le consentement (rencontres adultes + règles)
   - Crée socialProfiles/{uid} (status "pending" jusqu'à profil complet)
   - Lève users/{uid}.social.enabled = true (drapeau d'activation)
   SÉPARATION : le profil Élu (publicProfiles) et le profil Social
   (socialProfiles) restent DEUX documents distincts. Seul l'uid est commun.
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

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        if (!idToken) return err(401, "idToken requis");

        /* Consentement OBLIGATOIRE (rencontres adultes 18+ + acceptation des règles). */
        if (body.consent !== true) return err(400, "Ou dwe aksepte kondisyon Bizen Social yo (18 an+).");

        /* Année de naissance -> âge. On refuse < 18 ans. */
        var birthYear = parseInt(body.birthYear, 10);
        var yearNow = new Date().getFullYear();
        if (!birthYear || birthYear < 1900 || (yearNow - birthYear) < 18) {
            return err(403, "Bizen Social se pou granmoun 18 an+ sèlman.");
        }

        var pseudo = (body.pseudo || "").toString().trim().slice(0, 40);
        var gender = ["homme", "femme", "autre"].indexOf(body.gender) !== -1 ? body.gender : "";
        var seeking = ["homme", "femme", "tous"].indexOf(body.seeking) !== -1 ? body.seeking : "tous";
        if (!pseudo) return err(400, "Chwazi yon non/pseudo.");
        if (!gender) return err(400, "Chwazi sèks ou.");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();
        var nowTs = admin.firestore.Timestamp.now();

        /* Le membre doit exister (compte Bizen). On récupère prénom/ville si dispo. */
        var userSnap = await dbf.collection("users").doc(uid).get();
        var user = userSnap.exists ? userSnap.data() : {};

        /* Compte gelé/suspendu Bizen => pas d'activation Social. */
        if (user.status && user.status !== "active") {
            return err(403, "Kont ou pa aktif. Ou pa ka aktive Bizen Social kounye a.");
        }

        var profileRef = dbf.collection("socialProfiles").doc(uid);
        var existing = await profileRef.get();

        /* Déjà activé : on ne réinitialise pas, on renvoie l'état actuel. */
        if (existing.exists && existing.data().activatedAt) {
            return ok({ success: true, already: true, status: existing.data().status || "active" });
        }

        var zone = (body.zone || user.localisation || user.zone || "").toString().trim().slice(0, 60);

        var profileDoc = {
            uid: uid,
            pseudo: pseudo,
            gender: gender,
            seeking: seeking,
            birthYear: birthYear,
            zone: zone,
            bio: "",
            photos: [],                 /* URLs Firebase Storage, ajoutées à l'onboarding */
            prefs: { minAge: 18, maxAge: 99, maxDistanceKm: 100 },
            visible: false,             /* devient true a la fin de l'onboarding (photos) */
            discoverable: false,        /* pas dans Dekouvri avant d'avoir des photos */
            incognito: false,
            availableNow: null,
            status: "active",           /* compte actif direct, pas de liste d'attente */
            createdAt: nowTs,
            activatedAt: nowTs,
            lastActive: nowTs
        };
        await profileRef.set(profileDoc, { merge: true });

        /* Droits par défaut (freemium). Premium sera écrit par le paiement (wallet/MonCash). */
        await dbf.collection("socialEntitlements").doc(uid).set({
            premiumUntil: null,
            boostCredits: 0,
            superCredits: 1,            /* 1 Super Like offert au démarrage */
            platform: "web",
            updatedAt: nowTs
        }, { merge: true });

        /* Drapeau d'activation sur le compte Bizen (sert au bouton "1 clic"). */
        await dbf.collection("users").doc(uid).set({
            social: {
                enabled: true,
                activatedAt: nowTs,
                consentAt: nowTs,
                consentVersion: 1
            }
        }, { merge: true });

        return ok({ success: true, status: "pending" });
    } catch (e) {
        console.error("[SOCIAL-ACTIVATE]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
