/* Bizen HT - Service Worker (PWA + FCM)
   Stratégie: network-first (toujours le contenu le plus récent,
   avec repli sur le cache si hors-ligne) + notifications push. */

/* ===== FCM (notifications push en arrière-plan) ===== */
try {
    importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');
    firebase.initializeApp({
        apiKey: "AIzaSyADWklo0scZNWkhudRn_VBhrapXl4AZL_E",
        authDomain: "bizen-ht.firebaseapp.com",
        projectId: "bizen-ht",
        storageBucket: "bizen-ht.firebasestorage.app",
        messagingSenderId: "248857953518",
        appId: "1:248857953518:web:f85b1b37abd849add01fff"
    });
    var _msg = firebase.messaging();
    _msg.onBackgroundMessage(function (payload) {
        var n = (payload && payload.notification) || {};
        var d = (payload && payload.data) || {};
        self.registration.showNotification(n.title || "Bizen HT", {
            body: n.body || d.body || "",
            icon: "/icon.svg", badge: "/icon.svg",
            data: { link: d.link || "/Dashboard.html" }
        });
    });
} catch (e) { /* FCM indisponible: on garde au moins le cache PWA */ }

self.addEventListener("notificationclick", function (e) {
    e.notification.close();
    var link = (e.notification.data && e.notification.data.link) || "/Dashboard.html";
    e.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].url.indexOf(link) !== -1 && "focus" in list[i]) return list[i].focus();
            }
            if (clients.openWindow) return clients.openWindow(link);
        })
    );
});

var CACHE_NAME = "bizen-ht-v1";

self.addEventListener("install", function (e) {
    self.skipWaiting();
});

self.addEventListener("activate", function (e) {
    e.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys.filter(function (k) { return k !== CACHE_NAME; })
                    .map(function (k) { return caches.delete(k); })
            );
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener("fetch", function (e) {
    /* On ne gère que les requêtes GET de même origine */
    if (e.request.method !== "GET") return;

    e.respondWith(
        fetch(e.request)
            .then(function (res) {
                /* Met en cache une copie pour le mode hors-ligne */
                var copy = res.clone();
                caches.open(CACHE_NAME).then(function (cache) {
                    cache.put(e.request, copy).catch(function () {});
                });
                return res;
            })
            .catch(function () {
                /* Hors-ligne: on sert depuis le cache si possible */
                return caches.match(e.request);
            })
    );
});
