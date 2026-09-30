const CACHE='cybermg-map-v15-stage3-layers';
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
  './media-stops.js',
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
  './assets/media-stops/media-01.svg',
  './assets/media-stops/media-02.svg',
  './assets/media-stops/media-03.svg',
  './assets/media-stops/media-04.svg',
  './assets/media-stops/media-05.svg',
  './assets/media-stops/media-06.svg',
  './assets/media-stops/media-07.svg',
  './assets/media-stops/media-08.svg',
  './assets/media-stops/media-09.svg',
  './assets/media-stops/media-10.svg',
  './assets/media-stops/media-11.svg',
  './assets/media-stops/media-12.svg',
  './assets/media-stops/media-13.svg',
  './assets/media-stops/media-14.svg',
  './assets/media-stops/media-15.svg',
  './assets/media-stops/media-16.svg',
  './assets/media-stops/media-17.svg',
  './assets/media-stops/media-18.svg',
  './assets/media-stops/media-19.svg',
  './assets/media-stops/media-20.svg',
  './assets/media-stops/media-21.svg',
  './assets/media-stops/media-22.svg',
  './assets/media-stops/media-23.svg',
  './assets/media-stops/media-24.svg',
  './assets/media-stops/media-25.svg',
  './assets/media-stops/media-26.svg',
  './assets/media-stops/media-27.svg',
  './assets/media-stops/media-28.svg',
  './assets/media-stops/media-29.svg',
  './assets/media-stops/media-30.svg'
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
