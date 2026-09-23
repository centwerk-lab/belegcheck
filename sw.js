// Service Worker: App-Dateien zwischenspeichern → schneller Start, funktioniert auch ohne Empfang
// (nur das Scannen braucht Internet). Relative Pfade, damit es auch unter /belegcheck/ läuft.
const CACHE = 'belegcheck-v2';
const SHELL = ['./', 'index.html', 'style.css', 'categories.js', 'db.js', 'gemini.js', 'local-api.js', 'app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Nur eigene Dateien – Anfragen an Gemini laufen ungestört durch
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Netzwerk zuerst (Updates sofort sichtbar), Cache als Rückfall ohne Empfang
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
