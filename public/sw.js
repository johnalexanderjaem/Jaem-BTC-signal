// JAEM — Service Worker
// 1) Permite que showNotification() funcione en Chrome Android.
// 2) Hace la app instalable (PWA).
// 3) NUEVO: escucha eventos "push" del servidor (Netlify Function programada)
//    y muestra la notificación aunque el navegador esté cerrado o el celular bloqueado.

const SW_VERSION = 'jaem-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Notificación push real, disparada por netlify/functions/check-signals.js
self.addEventListener('push', (event) => {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'JAEM', body: event.data ? event.data.text() : 'Nueva señal' };
  }
  var title = data.title || 'JAEM — Trading Latino Signal';
  var options = {
    body: data.body || '',
    icon: data.icon || 'icon-192.png',
    badge: data.badge || 'icon-192.png',
    vibrate: [100, 50, 100],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Al tocar la notificación, enfoca la app si ya está abierta, o la abre.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
