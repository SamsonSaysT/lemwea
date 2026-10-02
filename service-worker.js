const CACHE_NAME = 'lemons-weather-v56';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    if(self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch(_e) {}
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if(request.method !== 'GET') return;

  const url = new URL(request.url);
  // Weather/radar/geocoding/API calls stay live. Browser HTTP caching still works,
  // but the PWA never pins stale forecast data in its own cache.
  if(url.origin !== self.location.origin) return;

  if(request.mode === 'navigate') {
    /* Clone the network response before exposing it to respondWith. That keeps
       the cache write race-free and lets waitUntil safely finish in background. */
    const network = (async () => {
      const response = await event.preloadResponse || await fetch(request);
      return {response, cacheCopy:response?.ok ? response.clone() : null};
    })();

    event.respondWith(
      network.then(x => x.response).catch(async () =>
        (await caches.match('./index.html')) || (await caches.match('./'))
      )
    );
    event.waitUntil(
      network.then(async ({cacheCopy}) => {
        if(!cacheCopy) return;
        const cache = await caches.open(CACHE_NAME);
        await cache.put('./index.html', cacheCopy);
      }).catch(() => {})
    );
    return;
  }

  const responseTask = (async () => {
    const cached = await caches.match(request);
    if(cached) return {response:cached, cacheCopy:null};
    const response = await fetch(request);
    const cacheable = response?.ok && (response.type === 'basic' || response.type === 'default');
    return {response, cacheCopy:cacheable ? response.clone() : null};
  })();

  event.respondWith(responseTask.then(x => x.response));
  event.waitUntil(
    responseTask.then(async ({cacheCopy}) => {
      if(!cacheCopy) return;
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, cacheCopy);
    }).catch(() => {})
  );
});
