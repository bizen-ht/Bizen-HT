/* Bizen HT — Service Worker FCM (notifications push en arrière-plan) */
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

var messaging = firebase.messaging();

messaging.onBackgroundMessage(function (payload) {
    var n = (payload && payload.notification) || {};
    var d = (payload && payload.data) || {};
    self.registration.showNotification(n.title || "Bizen HT", {
        body: n.body || d.body || "",
        icon: "/icon.svg",
        badge: "/icon.svg",
        data: { link: d.link || "/Dashboard.html" }
    });
});

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
