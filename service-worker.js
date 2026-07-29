// Service worker minimo, solo per rendere il pannello installabile come app.
// Non mette nulla in cache di proposito: i contenuti devono sempre essere
// aggiornati, non serviti da una copia vecchia salvata sul telefono.
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) { /* pass-through, nessuna cache */ });
