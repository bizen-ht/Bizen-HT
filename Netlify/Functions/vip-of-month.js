/* ====================================
   BIZEN HT — TOP 3 VIP DU MOIS (automatique)
   S'exécute chaque jour (@daily) mais N'AGIT QU'UNE FOIS PAR MOIS :
   au 1er passage après le changement de mois, il clôture le MOIS PRÉCÉDENT.

   Critère : les 3 VIP avec le PLUS de rencontres CONFIRMÉES (met:true) dans le
   mois. Départage : le plus DÉPENSÉ. Minimum : au moins 1 rencontre confirmée.
   Récompense : 5% du total dépensé du mois -> crédit walletBalance (auto).
   Publication : config/vipOfMonth (lisible par tous) => badge doré "VIP Mwa a"
   affiché aux Elus dans le chat + les posts de demande.

   "Dépensé" = somme des montants des réservations CONFIRMÉES (met:true) dont
   metAt tombe dans le mois. Requête par plage sur metAt uniquement (pas
   d'index composite requis).
   ==================================== */
const admin = require('firebase-admin');

var REWARD_PCT = 0.05;   /* 5% du total dépensé du mois */
var TOP_N = 3;

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

/* "YYYY-MM" du mois précédent + bornes [start, end). */
function prevMonthRange(now) {
    var y = now.getUTCFullYear();
    var m = now.getUTCMonth();         /* 0-11, mois courant */
    var start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));   /* 1er du mois précédent */
    var end = new Date(Date.UTC(y, m, 1, 0, 0, 0));         /* 1er du mois courant */
    var key = start.getUTCFullYear() + "-" + ("0" + (start.getUTCMonth() + 1)).slice(-2);
    return { start: start, end: end, key: key };
}

function amountOf(r) {
    return Math.round(parseFloat(r.amount || String(r.price || "0").replace(/[^0-9]/g, "")) || 0);
}

exports.handler = async function () {
    try {
        init();
        var dbf = admin.firestore();
        var FieldValue = admin.firestore.FieldValue;
        var Timestamp = admin.firestore.Timestamp;

        var range = prevMonthRange(new Date());
        var cfgRef = dbf.collection("config").doc("vipOfMonth");

        /* Idempotence : déjà clôturé pour ce mois ? on ne refait rien. */
        var cfgSnap = await cfgRef.get();
        if (cfgSnap.exists && cfgSnap.data().month === range.key) {
            return { statusCode: 200, body: JSON.stringify({ skipped: true, month: range.key }) };
        }

        /* Toutes les rencontres confirmées du mois précédent (plage sur metAt). */
        var snap = await dbf.collection("reservations")
            .where("metAt", ">=", Timestamp.fromDate(range.start))
            .where("metAt", "<", Timestamp.fromDate(range.end))
            .get();

        /* Agrégation par VIP. */
        var byVip = {};   /* uid -> { count, spend } */
        snap.forEach(function (doc) {
            var r = doc.data();
            if (r.met !== true) return;
            if (r.test === true) return;   /* pas les réservations de test */
            if (r.paid !== true) return;   /* dépenses RÉELLES uniquement */
            var uid = r.userId;
            if (!uid) return;
            if (!byVip[uid]) byVip[uid] = { count: 0, spend: 0 };
            byVip[uid].count += 1;
            byVip[uid].spend += amountOf(r);
        });

        /* Classement : rencontres confirmées desc, puis dépense desc. Min 1. */
        var ranked = Object.keys(byVip).map(function (uid) {
            return { uid: uid, count: byVip[uid].count, spend: byVip[uid].spend };
        }).filter(function (v) { return v.count >= 1; });
        ranked.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return b.spend - a.spend;
        });
        var top = ranked.slice(0, TOP_N);

        /* Récompense + noms. */
        var winners = [];
        for (var i = 0; i < top.length; i++) {
            var w = top[i];
            var reward = Math.round(w.spend * REWARD_PCT);
            var name = "VIP";
            try {
                var uSnap = await dbf.collection("users").doc(w.uid).get();
                if (uSnap.exists) {
                    var ud = uSnap.data();
                    name = ud.pseudo || ud.prenom || "VIP";
                }
            } catch (e) { /* nom par défaut */ }

            /* Crédit wallet (atomique via increment). */
            if (reward > 0) {
                try {
                    await dbf.collection("users").doc(w.uid).set({
                        walletBalance: FieldValue.increment(reward)
                    }, { merge: true });
                    await dbf.collection("cashbacks").add({
                        userId: w.uid, type: "vip_of_month", month: range.key,
                        rank: i + 1, meetings: w.count, monthlySpend: w.spend,
                        amount: reward, pct: REWARD_PCT,
                        createdAt: FieldValue.serverTimestamp()
                    });
                } catch (e) { console.error("[VIP-MONTH] reward", w.uid, e.message); }
            }

            /* Notif push best-effort. */
            try {
                var tSnap = await dbf.collection("users").doc(w.uid).get();
                var tks = (tSnap.exists && tSnap.data().fcmTokens) || [];
                if (tks.length) {
                    await admin.messaging().sendEachForMulticast({
                        tokens: tks,
                        notification: {
                            title: "Ou se VIP MWA a! 👑",
                            body: "Felisitasyon! Ou nan Top " + TOP_N + " VIP mwa a." + (reward > 0 ? " Ou touche " + reward.toLocaleString() + " Gdes nan wallet ou." : "")
                        },
                        data: { link: "/Dashboard.html" }
                    });
                }
            } catch (e) { /* best effort */ }

            winners.push({ uid: w.uid, name: name, rank: i + 1, meetings: w.count, spend: w.spend, reward: reward });
        }

        /* Publication (badge doré). uids = tableau pratique pour le client. */
        await cfgRef.set({
            month: range.key,
            uids: winners.map(function (x) { return x.uid; }),
            winners: winners,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        return { statusCode: 200, body: JSON.stringify({ month: range.key, winners: winners.length }) };
    } catch (e) {
        console.error("[VIP-MONTH]", e.message);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
