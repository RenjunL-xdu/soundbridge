// Offline cache. The whole point of an acoustic link is working without a
// network, so the app itself must not need one after the first visit.

const CACHE = 'sonar-transfer-v1';
const ASSETS = [
  './',
  './index.html',
  './calibrate.html',
  './manifest.webmanifest',
  './src/ui/styles.css',
  './src/ui/app.js',
  './src/ui/calibrate.js',
  './src/audio/io.js',
  './src/audio/recorder-worklet.js',
  './src/dsp/fft.js',
  './src/dsp/window.js',
  './src/dsp/qam.js',
  './src/dsp/chirp.js',
  './src/dsp/ofdm.js',
  './src/dsp/psycho.js',
  './src/dsp/sounder.js',
  './src/fec/crc.js',
  './src/fec/reedsolomon.js',
  './src/fec/fountain.js',
  './src/proto/bands.js',
  './src/proto/packet.js',
  './src/proto/burst.js',
  './src/proto/session.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, falling back to cache.
//
// Cache-first is the usual choice for an offline app, but it strands users on
// whatever code they first loaded: after a deploy the browser keeps serving the
// old modules and the app silently runs a stale version. These files are small,
// so preferring the network when one is available costs little and guarantees
// the code matches the site. Offline still works entirely from cache, which is
// the property that actually matters here.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && sameOrigin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || Promise.reject(new Error('offline'))))
  );
});
