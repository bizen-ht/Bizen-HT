/* ====================================
   BIZEN HT — Création de compte par l'ADMIN
   Permet à l'administrateur d'inscrire manuellement un Itilizatè ou
   un Elu pour une personne qui ne peut pas s'inscrire elle-même.
   Le compte est créé avec emailVerified = TRUE (pas de vérification
   d'e-mail requise pour se connecter).
   Sécurité : seul l'admin (vérifié via son idToken) peut appeler.
   ==================================== */
const admin = require('firebase-admin');

var ADMIN_EMAIL = "bizenht@gmail.com";

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

function ok(body)  { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function err(code, msg) { return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS, body: "" };
    }
    if (event.httpMethod !== "POST") {
        return err(405, "Method Not Allowed");
    }

    try {
        init();
        var body = JSON.parse(event.body || "{}");

        /* --- 1. Authentification de l'appelant : doit être l'admin --- */
        var idToken = body.idToken;
        if (!idToken) return err(401, "idToken requis");
        var decoded = await admin.auth().verifyIdToken(idToken);
        if (!decoded || decoded.email !== ADMIN_EMAIL) {
            return err(403, "Aksè entèdi : admin sèlman.");
        }

        /* --- 2. Validation des champs --- */
        var type = (body.type === "freelancer") ? "freelancer" : "user";
        var email = (body.email || "").toString().trim().toLowerCase();
        var password = (body.password || "").toString();
        var prenom = (body.prenom || "").toString().trim().slice(0, 60);
        var nom = (body.nom || "").toString().trim().slice(0, 60);
        var telephone = (body.telephone || "").toString().trim().slice(0, 30);

        var isTest = (body.isTest === true);

        if (!email || email.indexOf("@") === -1) return err(400, "Imèl pa valab.");
        if (!password || password.length < 6) return err(400, "Modpas dwe gen omwen 6 karaktè.");
        if (!prenom) return err(400, "Prenon obligatwa.");

        /* --- 3. Création du compte Auth (emailVerified = true) --- */
        var userRecord;
        try {
            userRecord = await admin.auth().createUser({
                email: email,
                password: password,
                emailVerified: true,
                displayName: (prenom + " " + nom).trim()
            });
        } catch (e) {
            if (e.code === "auth/email-already-exists") {
                return err(409, "Yon kont egziste deja ak imèl sa a.");
            }
            return err(400, e.message || "Erè kreyasyon kont.");
        }

        var uid = userRecord.uid;
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var now = FieldValue.serverTimestamp();

        var bizenCode = "BZ-" + Math.random().toString(36).substr(2, 4).toUpperCase()
            + Math.floor(100 + Math.random() * 900);

        if (type === "freelancer") {
            /* --- ELU --- */
            var genre = (body.genre || "").toString().trim();
            var localisation = (body.localisation || "").toString().trim();
            var zones = Array.isArray(body.zones) ? body.zones.slice(0, 20) : [];
            var prixMoment = parseInt(body.prixMoment, 10) || 0;
            var description = (body.description || "").toString().slice(0, 1000);
            var commissionPct = 10;
            var commission = Math.round(prixMoment * commissionPct / 100);
            var prixNet = prixMoment - commission;

            await dbf.collection("publicProfiles").doc(uid).set({
                prenom: prenom, nomInitial: (nom.charAt(0) || "") + ".",
                pseudo: (body.pseudo || "").toString().trim(),
                type: "freelancer", genre: genre, localisation: localisation,
                zones: zones, prixMoment: prixMoment, description: description,
                photoUrl: "", bizenCode: bizenCode, isPremium: isTest,
                isTest: isTest,
                status: "active", isOnline: false, lastSeen: null,
                regActive: false,
                createdAt: now
            });

            await dbf.collection("users").doc(uid).set({
                prenom: prenom, nom: nom, pseudo: (body.pseudo || "").toString().trim(),
                email: email, telephone: telephone,
                genre: genre, localisation: localisation,
                dateNesans: (body.dateNesans || "").toString(),
                prixMoment: prixMoment, prixNet: prixNet,
                commissionBizen: commission, commissionPct: commissionPct,
                description: description, isPremium: isTest,
                isTest: isTest,
                type: "freelancer", status: "active",
                emailVerified: true,
                createdByAdmin: true,
                regActive: false,
                bizenCode: bizenCode, zones: zones,
                isOnline: false, lastSeen: null,
                solde: 0, totalEarnings: 0, reservations: 0,
                createdAt: now, lastLogin: now
            });
        } else {
            /* --- ITILIZATÈ (client) --- */
            await dbf.collection("users").doc(uid).set({
                prenom: prenom, nom: nom, email: email, telephone: telephone,
                type: "user", status: "active",
                emailVerified: true,
                createdByAdmin: true,
                isPremium: isTest, isTest: isTest, favorites: [],
                createdAt: now, lastLogin: now
            });
        }

        return ok({ success: true, uid: uid, type: type, email: email });
    } catch (e) {
        console.error("[ADMIN-CREATE-USER]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
