self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {
    title: 'Alerta Nugon',
    body: 'Se solicitó ayuda mediante Nugon SOS.',
    timestamp: Date.now(),
    url: '/'
  };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      // Un payload no JSON no se muestra para evitar contenido no validado.
    }
  }

  const hasCoordinates = typeof data.latitude === 'number' && typeof data.longitude === 'number';
  const targetUrl = hasCoordinates
    ? `https://maps.google.com/?q=${data.latitude},${data.longitude}`
    : (data.url || '/');
  const actions = hasCoordinates
    ? [
      { action: 'open_map', title: 'Abrir ubicación' },
      { action: 'open_app', title: 'Abrir Nugon SOS' }
    ]
    : [{ action: 'open_app', title: 'Abrir Nugon SOS' }];

  const notification = self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'logo-192.png',
    badge: 'logo-192.png',
    vibrate: [500, 110, 500, 110, 1000],
    requireInteraction: true,
    renotify: true,
    tag: `nugon-emergency-${data.timestamp || Date.now()}`,
    actions,
    data: { targetUrl, hasCoordinates }
  });

  const notifyOpenClients = clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientList) => {
      clientList.forEach((client) => client.postMessage({
        type: 'EMERGENCY_ALERT',
        data
      }));
    });
  event.waitUntil(Promise.all([notification, notifyOpenClients]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  if (event.action === 'open_map' && notificationData.hasCoordinates) {
    event.waitUntil(clients.openWindow(notificationData.targetUrl));
    return;
  }
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((client) => client.url.startsWith(self.location.origin));
      return existing && 'focus' in existing ? existing.focus() : clients.openWindow('/');
    })
  );
});
