// Service Worker para Nugon SOS - Recepción de Notificaciones Push de Alta Prioridad
// Scope acotado exclusivamente a /nugon/

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  console.log('[SW Nugon] Push recibido:', event);

  let data = {
    title: '🚨 ¡ALERTA DE EMERGENCIA NUGON!',
    body: 'Se ha recibido un aviso de auxilio de tu familiar.',
    url: '/nugon/',
    timestamp: Date.now()
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const title = data.title || '🚨 ¡ALERTA DE EMERGENCIA!';
  const mapsUrl = data.url || (data.latitude && data.longitude ? `https://maps.google.com/?q=${data.latitude},${data.longitude}` : '/nugon/');

  const options = {
    body: data.body,
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%23DC2626"/><text x="50" y="72" text-anchor="middle" fill="white" font-size="65" font-weight="bold">🚨</text></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23DC2626"/></svg>',
    vibrate: [500, 110, 500, 110, 500, 110, 500, 110, 1000],
    requireInteraction: true,
    tag: data.is_test ? 'nugon-test' : 'nugon-emergency-' + (data.timestamp || Date.now()),
    renotify: true,
    data: {
      url: mapsUrl,
      sender_id: data.sender_id,
      latitude: data.latitude,
      longitude: data.longitude,
      timestamp: data.timestamp,
      is_test: data.is_test
    },
    actions: mapsUrl.includes('maps') ? [
      { action: 'open_map', title: '🗺️ Abrir Google Maps' },
      { action: 'open_app', title: '📱 Abrir Nugon SOS' }
    ] : [
      { action: 'open_app', title: '📱 Abrir Nugon SOS' }
    ]
  };

  // Notificar a pestañas/clientes activos dentro del scope /nugon/
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      clientList.forEach((client) => {
        client.postMessage({
          type: 'EMERGENCY_ALERT',
          data: data
        });
      });
      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || '/nugon/';

  if (event.action === 'open_map' && targetUrl.includes('http')) {
    event.waitUntil(clients.openWindow(targetUrl));
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (let client of clientList) {
        if (client.url && client.url.includes('/nugon') && 'focus' in client) {
          client.postMessage({
            type: 'EMERGENCY_ALERT_OPEN',
            data: notificationData
          });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/nugon/?alert=' + encodeURIComponent(JSON.stringify(notificationData)));
      }
    })
  );
});
