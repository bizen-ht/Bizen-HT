/* ====================================
   BIZEN HT — Anbasadè (auto-activation + "touche ou kontinye")
   Tout VIP (premium ou gratuit) peut s'auto-activer ambassadeur. Il recrute
   des Elus via son code. À chaque palier atteint, il choisit : TOUCHER la prime
   actuelle (son compteur repart à zéro) ou CONTINUER vers une plus grosse.

   Actions (Admin SDK, auth par idToken) :
   - activate : crée l'espace ambassadeur du VIP (génère un code unique).
   - claim    : recalcule les Elus confirmés, valide le palier, enregistre une
                demande de paiement (ambassadorPayouts) et remet le compteur à 0.

   Barème (1ère prime adaptée aux Premium, qui ont déjà Premium) :
     2 Elu  -> Gratuit: 1 mwa Premium | Premium: 1 000 G
     4 Elu  -> 1 250 G
     6 Elu  -> 2 000 G
     8 Elu  -> 3 500 G
    10 Elu  -> Gratuit: 5 000 G + Premium | Premium: 5 000 G
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

var MILESTONES = [2, 4, 6, 8, 10];

/* Prime pour un palier atteint, selon le statut Premium de l'ambassadeur. */
function prizeFor(n, isPremium) {
    if (n === 2)  return isPremium ? { type: "cash", cash: 1000, label: "1 000 G" }
                                   : { type: "premium", cash: 0, label: "1 mwa Premium gratis" };
    if (n === 4)  return { type: "cash", cash: 1250, label: "1 250 G" };
    if (n === 6)  return { type: "cash", cash: 2000, label: "2 000 G" };
    if (n === 8)  return { type: "cash", cash: 3500, label: "3 500 G" };
    if (n === 10) return isPremium ? { type: "cash", cash: 5000, label: "5 000 G" }
                                   : { type: "cash_premium", cash: 5000, label: "5 000 G + Premium" };
    return null;
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
        var nowTs = admin.firestore.Timestamp.now();

        /* ---------- ACTIVER SON ESPACE AMBASSADEUR ---------- */
        if (action === "activate") {
            var uSnap = await dbf.collection("users").doc(uid).get();
            if (!uSnap.exists) return err(404, "Kont pa jwenn.");
            var u = uSnap.data();
            if (u.type && u.type !== "user") return err(403, "Se sèlman VIP ki ka vin anbasadè.");

            var ex = await dbf.collection("ambassadors").where("ownerUid", "==", uid).limit(1).get();
            if (!ex.empty) return ok({ code: ex.docs[0].data().code || ex.docs[0].id, already: true });

            /* Code unique lisible : base sur le pseudo/prénom + 3 chiffres. */
            var base = (u.pseudo || u.prenom || "AMB").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6) || "AMB";
            var code = "", tries = 0;
            do {
                code = base + Math.floor(100 + Math.random() * 900);
                var c = await dbf.collection("ambassadors").doc(code).get();
                if (!c.exists) break;
                tries++;
            } while (tries < 6);

            await dbf.collection("ambassadors").doc(code).set({
                code: code,
                ownerUid: uid,
                ownerEmail: (u.email || "").toLowerCase(),
                ownerName: ((u.prenom || "") + " " + (u.nom || "")).trim() || u.pseudo || "VIP",
                active: true,
                resetBaseline: 0,
                totalClaimed: 0,
                createdAt: nowTs
            });
            return ok({ code: code });
        }

        /* ---------- TOUCHER LA PRIME ACTUELLE (reset à 0) ---------- */
        if (action === "claim") {
            var aSnap = await dbf.collection("ambassadors").where("ownerUid", "==", uid).limit(1).get();
            if (aSnap.empty) return err(404, "Ou poko anbasadè.");
            var aRef = aSnap.docs[0].ref;
            var a = aSnap.docs[0].data();
            var code = a.code || aSnap.docs[0].id;

            /* Recompte serveur : Elus CONFIRMÉS (publicProfiles actifs) via le code. */
            var pcSnap = await dbf.collection("publicProfiles")
                .where("ambassadorCode", "==", code).where("status", "==", "active").get();
            var total = pcSnap.size;
            var effective = Math.max(0, total - (a.resetBaseline || 0));

            var reached = 0;
            MILESTONES.forEach(function (n) { if (effective >= n) reached = n; });
            if (!reached) return err(400, "Ou poko rive nan premye palye a (" + MILESTONES[0] + " Elu konfime).");

            var uSnap2 = await dbf.collection("users").doc(uid).get();
            var isPrem = uSnap2.exists && uSnap2.data().isPremium === true;
            var prize = prizeFor(reached, isPrem);

            var moncash = (body.moncashNumber || "").toString().trim().slice(0, 40);
            if (prize.type !== "premium" && !moncash) {
                return err(400, "Antre nimewo MonCash ou pou n ka voye lajan an.");
            }

            await dbf.collection("ambassadorPayouts").add({
                ownerUid: uid,
                ownerEmail: a.ownerEmail || "",
                ownerName: a.ownerName || "",
                code: code,
                milestone: reached,
                effectiveAtClaim: effective,
                prizeType: prize.type,          /* cash | premium | cash_premium */
                prizeCash: prize.cash,
                prizeLabel: prize.label,
                moncashNumber: (prize.type !== "premium") ? moncash : "",
                status: "pending",
                requestedAt: nowTs
            });

            /* Compteur repart à ZÉRO : la base = total actuel. */
            await aRef.update({
                resetBaseline: total,
                lastClaimAt: nowTs,
                totalClaimed: FieldValue.increment(1)
            });

            return ok({ success: true, prize: prize.label, milestone: reached });
        }

        return err(400, "Aksyon enkoni.");
    } catch (e) {
        console.error("[AMBASSADOR]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
