const CACHE='cybermg-map-v14-native-stops';
const APP=[
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './backup-key.js',
  './backup-key-2.js',
  './branches.js',
  './stops.js',
  './manifest.webmanifest',
  './assets/stops/stop-01.svg',
  './assets/stops/stop-02.svg',
  './assets/stops/stop-03.svg',
  './assets/stops/stop-04.svg',
  './assets/stops/stop-05.svg',
  './assets/stops/stop-06.svg',
  './assets/stops/stop-07.svg',
  './assets/stops/stop-08.svg',
  './assets/stops/stop-09.svg',
  './assets/stops/stop-10.svg',
  './assets/stops/stop-11.svg',
  './assets/stops/stop-12.svg',
  './assets/stops/stop-13.svg',
  './assets/stops/stop-14.svg',
  './assets/stops/stop-15.svg',
  './assets/stops/stop-16.svg',
  './assets/stops/stop-17.svg',
  './assets/stops/stop-18.svg',
  './assets/stops/stop-19.svg',
  './assets/stops/stop-20.svg',
  './assets/stops/stop-21.svg',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
