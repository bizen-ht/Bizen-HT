/* ====================================
   BIZEN SOCIAL — API d'administration (réservé à l'admin)
   Panneau /vyerezo : gestion complète d'un réseau social (façon
   Instagram / OnlyFans / Tinder).
   L'appelant DOIT être l'admin (email vérifié côté serveur).
   Chaque action d'écriture est journalisée dans adminAudit.
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
function ok(b)  { return { statusCode: 200, headers: CORS, body: JSON.stringify(b) }; }
function err(c, m) { return { statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) }; }

/* Minuit à l'heure d'Haïti (UTC-5), en Timestamp. */
function haitiStartOfDay() {
    var n = new Date(Date.now() - 5 * 3600 * 1000);
    var ms = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + 5 * 3600 * 1000;
    return admin.firestore.Timestamp.fromMillis(ms);
}
function daysAgoTs(d) { return admin.firestore.Timestamp.fromMillis(Date.now() - d * 24 * 3600 * 1000); }

/* Compte robuste : essaie l'agrégation count(), sinon retombe sur un get borné. */
async function safeCount(q) {
    try { var s = await q.count().get(); return s.data().count; }
    catch (e) { try { var g = await q.limit(5000).get(); return g.size; } catch (e2) { return 0; } }
}

/* Supprime tous les docs d'une requête, par lots. */
async function deleteQuery(dbf, q) {
    while (true) {
        var snap = await q.limit(400).get();
        if (snap.empty) break;
        var batch = dbf.batch();
        snap.forEach(function (d) { batch.delete(d.ref); });
        await batch.commit();
        if (snap.size < 400) break;
    }
}

var dbf, ADMIN_UID;
async function audit(action, target, meta) {
    try {
        await dbf.collection("adminAudit").add({
            scope: "social", action: action, target: target || "",
            meta: meta || {}, by: ADMIN_UID, at: admin.firestore.Timestamp.now()
        });
    } catch (e) {}
}

function profileCard(id, d) {
    var age = d.birthYear ? (new Date().getFullYear() - d.birthYear) : null;
    return {
        uid: id, pseudo: d.pseudo || "", gender: d.gender || "", age: age,
        zone: d.zone || "", status: d.status || "active",
        photo: (d.photos && d.photos[0]) || "", photos: d.photos || [],
        bio: d.bio || "", verified: !!d.verified, featured: !!d.featured,
        ageVerified: !!d.ageVerified, discoverable: d.discoverable !== false,
        followersCount: d.followersCount || 0, followingCount: d.followingCount || 0,
        warnings: d.warnings || 0, nsfwFlags: d.nsfwFlags || 0,
        createdAt: d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : null,
        suspendUntil: d.suspendUntil && d.suspendUntil.toMillis ? d.suspendUntil.toMillis() : null
    };
}
function postCard(id, d) {
    return {
        id: id, authorUid: d.authorUid || "", authorName: d.authorName || "",
        authorAvatar: d.authorAvatar || "", imageUrl: d.imageUrl || "",
        caption: d.caption || "", hashtags: d.hashtags || [],
        likeCount: d.likeCount || 0, commentCount: d.commentCount || 0,
        repostOf: d.repostOf || "", hidden: !!d.hidden, nsfwFlag: !!d.nsfwFlag,
        nsfwScore: d.nsfwScore || 0,
        createdAt: d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : null
    };
}

/* Classe un compte : "elu" (fournisseur), "vip" (client Bizen payant),
   "social" (seulement Social). Lecture par lots des docs users. */
function classifyUser(x) {
    if (!x) return "social";
    if (x.type === "elu" || x.type === "prestataire" || x.bossId) return "elu";
    if (x.isPremium || (x.walletBalance || 0) > 0) return "vip";
    return "social";
}
async function enrichAccountType(users) {
    var ids = users.map(function (u) { return u.uid; });
    for (var i = 0; i < ids.length; i += 10) {
        var chunk = ids.slice(i, i + 10);
        try {
            var us = await dbf.collection("users").where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
            var map = {};
            us.forEach(function (d) { map[d.id] = classifyUser(d.data()); });
            users.forEach(function (u) { if (map[u.uid]) u.accountType = map[u.uid]; });
        } catch (e) {}
    }
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return err(405, "Method Not Allowed");

    try {
        init();
        var body = JSON.parse(event.body || "{}");
        var idToken = body.idToken;
        var action = body.action;
        if (!idToken) return err(401, "idToken requis");

        var decoded = await admin.auth().verifyIdToken(idToken);
        if (decoded.email !== ADMIN_EMAIL) return err(403, "Rezève pou administratè.");

        dbf = admin.firestore();
        ADMIN_UID = decoded.uid;
        var nowTs = admin.firestore.Timestamp.now();
        var C = function (n) { return dbf.collection(n); };

        /* ============ LECTURES ============ */

        if (action === "overview") {
            var today = haitiStartOfDay();
            var out = {};
            out.members       = await safeCount(C("socialProfiles"));
            out.membersActive = await safeCount(C("socialProfiles").where("status", "==", "active"));
            out.membersPending= await safeCount(C("socialProfiles").where("status", "==", "pending"));
            out.membersBanned = await safeCount(C("socialProfiles").where("status", "==", "banned"));
            out.newToday      = await safeCount(C("socialProfiles").where("createdAt", ">=", today));
            out.posts         = await safeCount(C("socialPosts"));
            out.postsToday    = await safeCount(C("socialPosts").where("createdAt", ">=", today));
            out.matches       = await safeCount(C("socialMatches"));
            out.matchesToday  = await safeCount(C("socialMatches").where("createdAt", ">=", today));
            out.messagesToday = await safeCount(C("socialMessages").where("createdAt", ">=", today));
            out.reportsOpen   = await safeCount(C("socialReports").where("status", "==", "open"));
            out.flagged       = await safeCount(C("socialPosts").where("nsfwFlag", "==", true));
            out.verified      = await safeCount(C("socialProfiles").where("verified", "==", true));
            out.discoverable  = await safeCount(C("socialProfiles").where("discoverable", "==", true));
            return ok({ success: true, stats: out });
        }

        if (action === "listUsers") {
            var status = body.status || "";
            var q = (body.q || "").toString().trim();
            var lim = Math.min(parseInt(body.limit, 10) || 30, 60);
            var query;
            if (q) {
                /* Recherche par préfixe de pseudo. */
                query = C("socialProfiles").orderBy("pseudo")
                    .startAt(q).endAt(q + "").limit(lim);
            } else {
                var fetchN = (status || body.gender) ? 200 : lim;
                query = C("socialProfiles").orderBy("createdAt", "desc").limit(fetchN);
                if (body.cursor && !status && !body.gender) query = query.startAfter(admin.firestore.Timestamp.fromMillis(body.cursor));
            }
            var snap = await query.get();
            var users = [], last = null;
            snap.forEach(function (d) { users.push(profileCard(d.id, d.data())); last = d.data().createdAt; });
            /* filtre genre en mémoire (évite un index composite) */
            if (status) users = users.filter(function (u) { return u.status === status; });
            if (body.gender) users = users.filter(function (u) { return u.gender === body.gender; });
            if (!q) users = users.slice(0, lim);
            if (body.accountType) { await enrichAccountType(users); users = users.filter(function (u) { return u.accountType === body.accountType; }); }
            else await enrichAccountType(users);
            return ok({ success: true, users: users, cursor: (last && last.toMillis && !q && !status && !body.gender && !body.accountType) ? last.toMillis() : null });
        }

        if (action === "getUser") {
            var uid = (body.uid || "").toString();
            if (!uid) return err(400, "uid requis");
            var pSnap = await C("socialProfiles").doc(uid).get();
            if (!pSnap.exists) return err(404, "Pwofil pa egziste.");
            var prof = profileCard(uid, pSnap.data());
            var postsSnap = await C("socialPosts").where("authorUid", "==", uid).limit(24).get();
            var posts = []; postsSnap.forEach(function (d) { posts.push(postCard(d.id, d.data())); });
            posts.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }); posts = posts.slice(0, 12);
            var repSnap = await C("socialReports").where("target", "==", uid).limit(20).get();
            var reports = []; repSnap.forEach(function (d) { var r = d.data(); reports.push({ id: d.id, reason: r.reason || "", details: r.details || "", reporter: r.reporter || "", status: r.status || "open", createdAt: r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : null }); });
            reports.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
            prof.postCount = await safeCount(C("socialPosts").where("authorUid", "==", uid));
            prof.matchCount = await safeCount(C("socialMatches").where("users", "array-contains", uid));
            var uDoc = await C("users").doc(uid).get();
            if (uDoc.exists) { var u = uDoc.data(); prof.email = u.email || ""; prof.realName = u.prenom || ""; }
            return ok({ success: true, profile: prof, posts: posts, reports: reports });
        }

        if (action === "listPosts") {
            var filter = body.filter || "all";
            var lim2 = Math.min(parseInt(body.limit, 10) || 24, 48);
            var pq;
            if (filter === "flagged") pq = C("socialPosts").where("nsfwFlag", "==", true).limit(lim2);
            else if (filter === "hidden") pq = C("socialPosts").where("hidden", "==", true).limit(lim2);
            else { pq = C("socialPosts").orderBy("createdAt", "desc").limit(lim2); if (body.cursor) pq = pq.startAfter(admin.firestore.Timestamp.fromMillis(body.cursor)); }
            var ps = await pq.get();
            var arr = [], lastP = null; ps.forEach(function (d) { arr.push(postCard(d.id, d.data())); lastP = d.data().createdAt; });
            if (filter !== "all") arr.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
            return ok({ success: true, posts: arr, cursor: (lastP && lastP.toMillis && filter === "all") ? lastP.toMillis() : null });
        }

        if (action === "listReports") {
            var st = body.status || "open";
            var rq = st === "all" ? C("socialReports").orderBy("createdAt", "desc").limit(60)
                : C("socialReports").where("status", "==", st).limit(60);
            var rs = await rq.get();
            var reps = [];
            for (var i = 0; i < rs.docs.length; i++) {
                var d = rs.docs[i], r = d.data();
                var tName = "";
                try { var t = await C("socialProfiles").doc(r.target || "").get(); if (t.exists) tName = t.data().pseudo || ""; } catch (e) {}
                reps.push({ id: d.id, reason: r.reason || "", details: r.details || "", reporter: r.reporter || "", target: r.target || "", targetName: tName, pairId: r.pairId || "", status: r.status || "open", createdAt: r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : null });
            }
            reps.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
            return ok({ success: true, reports: reps });
        }

        if (action === "analytics") {
            var since = daysAgoTs(14);
            var pSnap2 = await C("socialProfiles").where("createdAt", ">=", since).orderBy("createdAt", "asc").limit(2000).get();
            var byDaySignup = {};
            pSnap2.forEach(function (d) { var t = d.data().createdAt; if (t && t.toDate) { var k = new Date(t.toMillis() - 5 * 3600 * 1000).toISOString().slice(0, 10); byDaySignup[k] = (byDaySignup[k] || 0) + 1; } });
            var postSnap2 = await C("socialPosts").where("createdAt", ">=", since).orderBy("createdAt", "asc").limit(3000).get();
            var byDayPost = {}, tags = {};
            postSnap2.forEach(function (d) { var x = d.data(); var t = x.createdAt; if (t && t.toDate) { var k = new Date(t.toMillis() - 5 * 3600 * 1000).toISOString().slice(0, 10); byDayPost[k] = (byDayPost[k] || 0) + 1; } (x.hashtags || []).forEach(function (h) { tags[h] = (tags[h] || 0) + 1; }); });
            var topTags = Object.keys(tags).map(function (k) { return { tag: k, n: tags[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 15);
            return ok({ success: true, signups: byDaySignup, posts: byDayPost, topTags: topTags });
        }

        if (action === "listMatches") {
            var ms = await C("socialMatches").orderBy("createdAt", "desc").limit(50).get();
            var arr = [];
            ms.forEach(function (d) {
                var m = d.data();
                arr.push({ pairId: d.id, users: m.users || [], names: m.names || {}, avatars: m.avatars || {},
                    lastMessage: m.lastMessage || "", hasChatted: !!m.lastMessage,
                    createdAt: m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : null,
                    lastAt: m.lastAt && m.lastAt.toMillis ? m.lastAt.toMillis() : null });
            });
            return ok({ success: true, matches: arr });
        }

        if (action === "mapData") {
            var ps = await C("socialProfiles").where("status", "==", "active").limit(1500).get();
            var zones = {}, points = [];
            ps.forEach(function (d) {
                var x = d.data();
                var z = (x.zone || "").trim(); if (z) zones[z] = (zones[z] || 0) + 1;
                var g = x.geo;
                if (g) {
                    var lat = (typeof g.lat === "number") ? g.lat : g.latitude;
                    var lng = (typeof g.lng === "number") ? g.lng : g.longitude;
                    if (typeof lat === "number" && typeof lng === "number") points.push({ pseudo: x.pseudo || "", lat: lat, lng: lng, zone: z });
                }
            });
            var zoneArr = Object.keys(zones).map(function (k) { return { zone: k, n: zones[k] }; }).sort(function (a, b) { return b.n - a.n; });
            return ok({ success: true, zones: zoneArr, points: points, total: ps.size });
        }

        if (action === "segments") {
            var ps2 = await C("socialProfiles").limit(2000).get();
            var ids = []; ps2.forEach(function (d) { ids.push(d.id); });
            var seg = { elu: 0, vip: 0, social: 0, total: ids.length };
            for (var si = 0; si < ids.length; si += 10) {
                var chunk = ids.slice(si, si + 10);
                try {
                    var us = await C("users").where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
                    var seen = {};
                    us.forEach(function (d) { seen[d.id] = 1; seg[classifyUser(d.data())]++; });
                    chunk.forEach(function (id) { if (!seen[id]) seg.social++; });
                } catch (e) {}
            }
            return ok({ success: true, segments: seg });
        }

        if (action === "getConfig") {
            var cs = await C("settings").doc("social").get();
            return ok({ success: true, config: cs.exists ? cs.data() : {} });
        }

        /* ============ ÉCRITURES (journalisées) ============ */

        if (action === "deletePost") {
            var postId = (body.postId || "").toString();
            if (!postId) return err(400, "postId requis");
            try { await C("socialPosts").doc(postId).delete(); } catch (e) {}
            await deleteQuery(dbf, C("socialPostLikes").where("postId", "==", postId));
            await deleteQuery(dbf, C("socialPostComments").where("postId", "==", postId));
            await deleteQuery(dbf, C("socialSaves").where("postId", "==", postId));
            await audit("deletePost", postId, { reason: body.reason || "" });
            return ok({ success: true });
        }

        if (action === "hidePost" || action === "unhidePost") {
            var pid = (body.postId || "").toString(); if (!pid) return err(400, "postId requis");
            await C("socialPosts").doc(pid).set({ hidden: action === "hidePost" }, { merge: true });
            await audit(action, pid, {});
            return ok({ success: true });
        }
        if (action === "clearFlag") {
            var pid2 = (body.postId || "").toString(); if (!pid2) return err(400, "postId requis");
            await C("socialPosts").doc(pid2).set({ nsfwFlag: false }, { merge: true });
            await audit("clearFlag", pid2, {});
            return ok({ success: true });
        }

        if (action === "banProfile" || action === "unbanProfile") {
            var buid = (body.uid || "").toString(); if (!buid) return err(400, "uid requis");
            var banned = action === "banProfile";
            var upd = { status: banned ? "banned" : "active" };
            if (banned) { upd.visible = false; upd.discoverable = false; }
            await C("socialProfiles").doc(buid).set(upd, { merge: true });
            await audit(action, buid, { reason: body.reason || "" });
            return ok({ success: true, banned: banned });
        }
        if (action === "suspendProfile") {
            var suid = (body.uid || "").toString(); if (!suid) return err(400, "uid requis");
            var days = Math.min(parseInt(body.days, 10) || 7, 3650);
            await C("socialProfiles").doc(suid).set({ status: "suspended", discoverable: false, suspendUntil: admin.firestore.Timestamp.fromMillis(Date.now() + days * 24 * 3600 * 1000) }, { merge: true });
            await audit("suspendProfile", suid, { days: days, reason: body.reason || "" });
            return ok({ success: true });
        }
        if (action === "verifyProfile" || action === "unverifyProfile") {
            var vuid = (body.uid || "").toString(); if (!vuid) return err(400, "uid requis");
            await C("socialProfiles").doc(vuid).set({ verified: action === "verifyProfile" }, { merge: true });
            await audit(action, vuid, {});
            return ok({ success: true });
        }
        if (action === "ageVerifyProfile" || action === "unAgeVerifyProfile") {
            var auid = (body.uid || "").toString(); if (!auid) return err(400, "uid requis");
            await C("socialProfiles").doc(auid).set({ ageVerified: action === "ageVerifyProfile" }, { merge: true });
            await audit(action, auid, {});
            return ok({ success: true });
        }
        if (action === "featureProfile" || action === "unfeatureProfile") {
            var fuid = (body.uid || "").toString(); if (!fuid) return err(400, "uid requis");
            await C("socialProfiles").doc(fuid).set({ featured: action === "featureProfile" }, { merge: true });
            await audit(action, fuid, {});
            return ok({ success: true });
        }

        if (action === "warnUser") {
            var wuid = (body.uid || "").toString(); if (!wuid) return err(400, "uid requis");
            var msg = (body.message || "Ou resevwa yon avètisman pou kontni ki pa respekte règ Bizen Social.").toString().slice(0, 300);
            await C("socialProfiles").doc(wuid).set({ warnings: admin.firestore.FieldValue.increment(1) }, { merge: true });
            try {
                var uD = await C("users").doc(wuid).get();
                var tk = (uD.exists && uD.data().fcmTokens) || [];
                if (tk.length) await admin.messaging().sendEachForMulticast({ tokens: tk, notification: { title: "Avètisman Bizen Social", body: msg }, data: { link: "/social.html" } });
            } catch (e) {}
            await audit("warnUser", wuid, { message: msg });
            return ok({ success: true });
        }

        if (action === "resolveReport" || action === "dismissReport") {
            var rid = (body.reportId || "").toString(); if (!rid) return err(400, "reportId requis");
            await C("socialReports").doc(rid).set({ status: action === "dismissReport" ? "dismissed" : "handled", handledAt: nowTs, handledBy: ADMIN_UID }, { merge: true });
            await audit(action, rid, {});
            return ok({ success: true });
        }

        if (action === "deleteUser") {
            var duid = (body.uid || "").toString(); if (!duid) return err(400, "uid requis");
            /* Cascade : posts + sous-collections, swipes, matchs, messages, follows, likes, droits, blocages, profil. */
            var mine = await C("socialPosts").where("authorUid", "==", duid).limit(500).get();
            for (var pi = 0; pi < mine.docs.length; pi++) {
                var pd = mine.docs[pi].id;
                await deleteQuery(dbf, C("socialPostLikes").where("postId", "==", pd));
                await deleteQuery(dbf, C("socialPostComments").where("postId", "==", pd));
                await deleteQuery(dbf, C("socialSaves").where("postId", "==", pd));
            }
            await deleteQuery(dbf, C("socialPosts").where("authorUid", "==", duid));
            await deleteQuery(dbf, C("socialSwipes").where("from", "==", duid));
            await deleteQuery(dbf, C("socialSwipes").where("to", "==", duid));
            await deleteQuery(dbf, C("socialMatches").where("users", "array-contains", duid));
            await deleteQuery(dbf, C("socialMessages").where("participants", "array-contains", duid));
            await deleteQuery(dbf, C("socialFollows").where("follower", "==", duid));
            await deleteQuery(dbf, C("socialFollows").where("target", "==", duid));
            await deleteQuery(dbf, C("socialLikesReceived").where("owner", "==", duid));
            try { await C("socialEntitlements").doc(duid).delete(); } catch (e) {}
            try { await C("socialProfiles").doc(duid).delete(); } catch (e) {}
            try { await C("users").doc(duid).set({ social: admin.firestore.FieldValue.delete() }, { merge: true }); } catch (e) {}
            await audit("deleteUser", duid, {});
            return ok({ success: true });
        }

        if (action === "broadcast") {
            var title = (body.title || "Bizen Social").toString().slice(0, 80);
            var msgB = (body.body || "").toString().slice(0, 240);
            if (!msgB) return err(400, "Mesaj vid.");
            /* Cible : membres Social. On récupère les tokens depuis users (par lots). */
            var profs = await C("socialProfiles").where("status", "==", "active").limit(2000).get();
            var uids = []; profs.forEach(function (d) { uids.push(d.id); });
            var tokens = [];
            for (var k = 0; k < uids.length; k += 10) {
                var chunk = uids.slice(k, k + 10);
                var us = await C("users").where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
                us.forEach(function (d) { (d.data().fcmTokens || []).forEach(function (t) { if (t) tokens.push(t); }); });
            }
            var sent = 0;
            for (var b2 = 0; b2 < tokens.length; b2 += 500) {
                var part = tokens.slice(b2, b2 + 500);
                try { var r = await admin.messaging().sendEachForMulticast({ tokens: part, notification: { title: title, body: msgB }, data: { link: "/social.html" } }); sent += (r.successCount || 0); } catch (e) {}
            }
            await audit("broadcast", "", { title: title, sent: sent, targets: tokens.length });
            return ok({ success: true, sent: sent, targets: tokens.length });
        }

        if (action === "setConfig") {
            var patch = body.patch || {};
            var clean = {};
            ["phaseAllFree", "discoveryOpen", "maintenance", "requireAgeVerify", "nsfwThreshold"].forEach(function (k) { if (patch[k] !== undefined) clean[k] = patch[k]; });
            await C("settings").doc("social").set(clean, { merge: true });
            await audit("setConfig", "social", clean);
            return ok({ success: true });
        }

        return err(400, "action envalid");
    } catch (e) {
        console.error("[SOCIAL-ADMIN]", e.message);
        return err(500, e.message || "Erè sèvè.");
    }
};
