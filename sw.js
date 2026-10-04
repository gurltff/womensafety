/* SafeCircle India service worker: makes the app installable and keeps the
   app shell (SOS screen, helplines, toolkit) working offline.
   Bump CACHE when you change any file in SHELL. */
const CACHE = 'safecircle-v3.0.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'globe-data.js', 'globe.js', 'api.js', 'app.js', 'tools.js',
  'recorder.js', 'insights.js', 'verify.js', 'stats.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('safecircle-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Pages: network first so updates arrive, cached shell when offline.
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('index.html', copy));
        return res;
      }).catch(() => caches.match('index.html'))
    );
    return;
  }
  // App files and fonts: serve from cache, refresh in the background.
  if(sameOrigin || FONT_HOSTS.includes(url.hostname)){
    e.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if(res.ok || res.type === 'opaque'){
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
  // Everything else (map tiles, search, routing) goes straight to the network.
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      const open = list.find(c => 'focus' in c);
      return open ? open.focus() : self.clients.openWindow('./');
    })
  );
});
