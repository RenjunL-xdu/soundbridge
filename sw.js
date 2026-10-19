// 离线缓存：第一次加载后，即使没有互联网也能打开和使用声桥。

const CACHE = 'soundbridge-v1';
const ASSETS = [
  './',
  './index.html',
  './calibrate.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
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

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(ASSETS.map((asset) => cache.add(asset))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('./index.html'))),
  );
});
