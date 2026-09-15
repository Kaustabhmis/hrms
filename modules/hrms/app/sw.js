/* The offline shell.
   A worker on a factory floor loses signal constantly. The app itself must
   still open -- with the punch queue and the sign-in session intact -- so the
   files are cached on first run and served from the cache whenever the network
   is not there. Data is never cached: a stale attendance figure is worse than
   an honest "no connection". */
var CACHE = 'biscs-app-v1';
var SHELL = ['./', './index.html', './app.js', './supabase.js',
             './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
    e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
        return self.skipWaiting();
    }));
});
self.addEventListener('activate', function (e) {
    e.waitUntil(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
    var url = new URL(e.request.url);
    // Anything going to the database goes to the database, never to a cache.
    if (e.request.method !== 'GET' || url.origin !== location.origin) return;
    e.respondWith(
        fetch(e.request).then(function (res) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
            return res;
        }).catch(function () {
            return caches.match(e.request).then(function (hit) {
                return hit || caches.match('./index.html');
            });
        })
    );
});
