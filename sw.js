/* Bizen HT - Service Worker (PWA)
   Stratégie: network-first (toujours le contenu le plus récent,
   avec repli sur le cache si hors-ligne). */

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
