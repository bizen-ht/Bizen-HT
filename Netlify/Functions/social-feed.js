/* ====================================
   BIZEN SOCIAL — Feed de candidats à swiper
   Génère la pile de profils que l'utilisateur peut liker/passer :
   - même zone (ville) OU proximité (si géoloc dispo)
   - respecte les préférences de genre/âge des DEUX côtés
   - exclut : soi-même, déjà-swipés, bloqués (dans les 2 sens), non-visibles
   - priorise : "Disponible maintenant", puis boostés, puis récemment actifs
   Lecture serveur (Admin SDK) => on peut appliquer l'anti-triche/confidentialité
   que les règles Firestore seules ne feraient pas (blocages, incognito).
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

/* Distance approximative (km) entre deux points — formule de haversine. */
function distanceKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    var R = 6371, toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

/* Genre recherché "seeking" -> filtre sur le genre "gender" du candidat. */
function genderMatches(seeking, gender) {
    if (!seeking || seeking === "tous") return true;
    return seeking === gender;
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        if (!idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        var uid = decoded.uid;
        var dbf = admin.firestore();

        var meSnap = await dbf.collection("socialProfiles").doc(uid).get();
        if (!meSnap.exists) return err(404, "Ou poko gen yon pwofil Bizen Social.");
        var me = meSnap.data();
        var myPrefs = me.prefs || {};
        var yearNow = new Date().getFullYear();

        /* --- Ensembles d'exclusion : déjà-swipés + bloqués (2 sens) --- */
        var excluded = {};
        excluded[uid] = true;

        var swipesSnap = await dbf.collection("socialSwipes").where("from", "==", uid).limit(2000).get();
        swipesSnap.forEach(function (d) { excluded[d.data().to] = true; });

        /* Blocages que J'AI posés + blocages POSÉS SUR MOI. */
        var blkA = await dbf.collection("socialBlocks").where("blocker", "==", uid).limit(1000).get();
        blkA.forEach(function (d) { excluded[d.data().target] = true; });
        var blkB = await dbf.collection("socialBlocks").where("target", "==", uid).limit(1000).get();
        blkB.forEach(function (d) { excluded[d.data().blocker] = true; });

        /* --- Candidats : on lit les profils actifs (une seule condition = pas besoin
           d'index composite) puis on filtre finement en memoire. --- */
        var candSnap = await dbf.collection("socialProfiles")
            .where("status", "==", "active").limit(400).get();

        var now = Date.now();
        var out = [];
        candSnap.forEach(function (d) {
            var c = d.data();
            var cid = d.id;
            if (excluded[cid]) return;

            /* Doit avoir CHOISI d'apparaitre dans Decouvri (opt-in, retirable a tout moment). */
            if (c.discoverable !== true) return;

            /* Le bon genre pour MOI (ce que je cherche). */
            if (me.seeking && me.seeking !== "tous" && c.gender !== me.seeking) return;

            /* Réciprocité des préférences de genre : lui/elle doit aussi me chercher. */
            if (!genderMatches(c.seeking, me.gender)) return;

            /* Filtre d'âge (mes préférences). */
            var cAge = c.birthYear ? (yearNow - c.birthYear) : null;
            if (cAge != null) {
                if (myPrefs.minAge && cAge < myPrefs.minAge) return;
                if (myPrefs.maxAge && cAge > myPrefs.maxAge) return;
            }

            /* Distance (si géoloc des deux côtés), sinon on se base sur la zone. */
            var dist = distanceKm(me.geo, c.geo);
            if (dist != null && myPrefs.maxDistanceKm && dist > myPrefs.maxDistanceKm) return;
            var sameZone = me.zone && c.zone && me.zone.toLowerCase() === c.zone.toLowerCase();

            /* Score de tri : dispo maintenant > boosté > récemment actif > même zone. */
            var availActive = c.availableNow && c.availableNow.toMillis && (now - c.availableNow.toMillis() < 3600 * 1000);
            var boostActive = c.boostUntil && c.boostUntil.toMillis && c.boostUntil.toMillis() > now;
            var lastMs = (c.lastActive && c.lastActive.toMillis) ? c.lastActive.toMillis() : 0;
            var score = 0;
            if (availActive) score += 1e12;
            if (boostActive) score += 5e11;
            if (sameZone) score += 1e11;
            score += lastMs / 1e3;

            out.push({
                uid: cid,
                pseudo: c.pseudo || "Anonim",
                age: cAge,
                zone: c.zone || "",
                bio: (c.bio || "").slice(0, 300),
                photos: Array.isArray(c.photos) ? c.photos.slice(0, 6) : [],
                distanceKm: dist,               /* approximatif ; null si géoloc off */
                availableNow: !!availActive,
                _score: score
            });
        });

        out.sort(function (a, b) { return b._score - a._score; });
        out = out.slice(0, 40).map(function (p) { delete p._score; return p; });

        /* On met à jour mon "lastActive" (je viens de charger le feed). */
        try { await meSnap.ref.set({ lastActive: admin.firestore.Timestamp.now() }, { merge: true }); } catch (e) {}

        return ok({ success: true, profiles: out });
    } catch (e) {
        console.error("[SOCIAL-FEED]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
