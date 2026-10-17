// Cache only the public app shell. Notes and authentication responses never enter Cache Storage.
const CACHE = 'vault-v3-secure-20';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg',
  'secure-store.js', 'auth.js', 'editor.js', 'app.js', 'contextmenu.js', 'tablepicker.js', 'vendor/marked.min.js', 'vendor/purify.min.js',
  'vendor/codemirror.min.js'];
const shellURLs = new Set(CORE.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  // A partial download must not replace a working offline installation. Bypass the HTTP cache
  // (GitHub Pages sends max-age=600) so a new version never stores files from the previous one.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE.map(path => new Request(path, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('vault-') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !shellURLs.has(request.url)) return;
  event.respondWith((async () => {
    // Serve one complete version together; the service worker update swaps the shell atomically.
    const cache = await caches.open(CACHE);
    return await cache.match(request) || fetch(request);
  })());
});
