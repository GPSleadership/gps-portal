/* GPS Leadership Portal — minimal service worker.
   Its only job is to make the portal installable as an app. It deliberately does
   NOT cache pages or API responses, so the portal is always fresh and never
   serves stale data. Network-only passthrough. */
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { self.clients.claim(); });
self.addEventListener('fetch', function (e) { /* network-only: do nothing, let the browser handle it */ });
