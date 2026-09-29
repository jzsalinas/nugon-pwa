(function () {
  'use strict';

  const apiBase = '/api/v1';
  const storageKey = 'nugonLinksV1';

  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const enableButton = document.getElementById('enableNotificationsButton');
  const notificationHelp = document.getElementById('notificationHelp');
  const pairingForm = document.getElementById('pairingForm');
  const pairingCode = document.getElementById('pairingCode');
  const claimButton = document.getElementById('claimButton');
  const pairingResult = document.getElementById('pairingResult');
  const linksList = document.getElementById('linksList');
  const alertOverlay = document.getElementById('alertOverlay');
  const alertTitle = document.getElementById('alertTitle');
  const alertBody = document.getElementById('alertBody');
  const alertTime = document.getElementById('alertTime');
  const openMapsButton = document.getElementById('openMapsButton');
  const closeAlertButton = document.getElementById('closeAlertButton');

  let registration = null;
  let subscription = null;
  let audioContext = null;
  let sirenTimer = null;

  function readLinks() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
      return Array.isArray(value)
        ? value.filter((item) => item && item.linkId && item.linkSecret)
        : [];
    } catch {
      return [];
    }
  }

  function writeLinks(links) {
    localStorage.setItem(storageKey, JSON.stringify(links));
  }

  function setResult(message, kind = '') {
    pairingResult.textContent = message;
    pairingResult.className = `result ${kind}`.trim();
  }

  function updateStatus() {
    const links = readLinks();
    const notificationPermission = 'Notification' in window
      ? Notification.permission
      : 'denied';
    if (notificationPermission === 'granted' && links.length > 0) {
      statusPill.classList.add('active');
      statusText.textContent = `${links.length} vinculación${links.length === 1 ? '' : 'es'}`;
    } else if (notificationPermission === 'granted') {
      statusPill.classList.remove('active');
      statusText.textContent = 'Listo para vincular';
    } else {
      statusPill.classList.remove('active');
      statusText.textContent = 'Sin configurar';
    }
  }

  function renderLinks() {
    const links = readLinks();
    linksList.replaceChildren();
    if (links.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Este navegador todavía no tiene vinculaciones.';
      linksList.appendChild(empty);
      updateStatus();
      return;
    }

    links.forEach((link) => {
      const row = document.createElement('div');
      row.className = 'link-row';
      const details = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = link.displayName || 'Dispositivo Nugon';
      const date = document.createElement('span');
      date.textContent = link.linkedAt
        ? `Desde ${new Date(link.linkedAt).toLocaleDateString()}`
        : 'Vinculación activa';
      details.append(title, date);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-danger button-small';
      button.textContent = 'Desvincular';
      button.addEventListener('click', () => unlink(link, button));
      row.append(details, button);
      linksList.appendChild(row);
    });
    updateStatus();
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
  }

  async function api(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data && data.error ? data.error : 'REQUEST_FAILED');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function ensurePushSubscription() {
    if (!('Notification' in window)
        || !('serviceWorker' in navigator)
        || !('PushManager' in window)) {
      throw new Error('PUSH_UNAVAILABLE');
    }
    if (Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('NOTIFICATIONS_DENIED');
    }
    registration = registration || await navigator.serviceWorker.register('/sw.js', {
      scope: '/'
    });
    await navigator.serviceWorker.ready;
    subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const { publicKey } = await api('/vapid-public-key');
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    pairingCode.disabled = false;
    claimButton.disabled = false;
    notificationHelp.textContent = 'Notificaciones activadas. Ya puedes introducir el código.';
    enableButton.textContent = 'Notificaciones activadas';
    enableButton.disabled = true;
    updateStatus();
    return subscription;
  }

  enableButton.addEventListener('click', async () => {
    enableButton.disabled = true;
    notificationHelp.textContent = 'Preparando notificaciones…';
    try {
      await ensurePushSubscription();
    } catch (error) {
      enableButton.disabled = false;
      if (error.message === 'NOTIFICATIONS_DENIED') {
        notificationHelp.textContent = 'El permiso fue rechazado. Puedes habilitarlo desde los ajustes del navegador.';
      } else {
        notificationHelp.textContent = 'Este navegador no pudo activar Web Push.';
      }
    }
  });

  pairingCode.addEventListener('input', () => {
    const normalized = pairingCode.value.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '').slice(0, 12);
    pairingCode.value = [normalized.slice(0, 4), normalized.slice(4, 8), normalized.slice(8, 12)]
      .filter(Boolean)
      .join('-');
  });

  pairingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    claimButton.disabled = true;
    setResult('Comprobando el código…');
    try {
      const currentSubscription = await ensurePushSubscription();
      const result = await api('/pairings/claim', {
        method: 'POST',
        body: JSON.stringify({
          code: pairingCode.value,
          subscription: currentSubscription.toJSON()
        })
      });
      const links = readLinks().filter((item) => item.linkId !== result.linkId);
      links.push({
        linkId: result.linkId,
        linkSecret: result.linkSecret,
        displayName: result.displayName || 'Dispositivo Nugon',
        linkedAt: new Date().toISOString()
      });
      writeLinks(links);
      pairingCode.value = '';
      setResult('Vinculación completada. Este dispositivo recibirá las próximas alertas.', 'success');
      renderLinks();
    } catch (error) {
      const message = error.status === 429
        ? 'Se agotaron los intentos. Genera un código nuevo en Android.'
        : 'Código inválido, vencido o ya utilizado.';
      setResult(message, 'error');
    } finally {
      claimButton.disabled = !('Notification' in window)
        || Notification.permission !== 'granted';
    }
  });

  async function unlink(link, button) {
    button.disabled = true;
    button.textContent = 'Desvinculando…';
    try {
      await api(`/links/${encodeURIComponent(link.linkId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${link.linkSecret}` }
      });
      writeLinks(readLinks().filter((item) => item.linkId !== link.linkId));
      renderLinks();
    } catch (error) {
      if (error.status === 401 || error.status === 404) {
        writeLinks(readLinks().filter((item) => item.linkId !== link.linkId));
        renderLinks();
      } else {
        button.disabled = false;
        button.textContent = 'Desvincular';
        setResult('No se pudo desvincular. Comprueba la conexión.', 'error');
      }
    }
  }

  function startSiren() {
    stopSiren();
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const sound = () => {
        if (!audioContext) return;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.16, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.35);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.35);
      };
      sound();
      sirenTimer = window.setInterval(sound, 550);
    } catch {
      // La notificación del sistema sigue funcionando si el navegador bloquea audio.
    }
    if (navigator.vibrate) navigator.vibrate([500, 120, 500, 120, 900]);
  }

  function stopSiren() {
    if (sirenTimer) window.clearInterval(sirenTimer);
    sirenTimer = null;
    if (audioContext) audioContext.close().catch(() => undefined);
    audioContext = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  function showAlert(data) {
    alertTitle.textContent = data.title || 'Alerta Nugon';
    alertBody.textContent = data.body || 'Se solicitó ayuda mediante Nugon SOS.';
    alertTime.textContent = new Date(data.timestamp || Date.now()).toLocaleString();
    const hasCoordinates = typeof data.latitude === 'number' && typeof data.longitude === 'number';
    if (hasCoordinates) {
      openMapsButton.href = `https://maps.google.com/?q=${data.latitude},${data.longitude}`;
      openMapsButton.classList.remove('hidden');
    } else {
      openMapsButton.removeAttribute('href');
      openMapsButton.classList.add('hidden');
    }
    alertOverlay.classList.remove('hidden');
    startSiren();
  }

  closeAlertButton.addEventListener('click', () => {
    stopSiren();
    alertOverlay.classList.add('hidden');
  });

  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'EMERGENCY_ALERT') showAlert(event.data.data || {});
  });

  async function initialize() {
    renderLinks();
    if (!('Notification' in window)) {
      enableButton.disabled = true;
      notificationHelp.textContent = 'Este navegador no admite notificaciones Web Push.';
      return;
    }
    if (Notification.permission === 'granted') {
      try {
        await ensurePushSubscription();
      } catch {
        notificationHelp.textContent = 'No se pudo recuperar la suscripción Push.';
      }
    } else if (Notification.permission === 'denied') {
      notificationHelp.textContent = 'Las notificaciones están bloqueadas en este navegador.';
    }
  }

  initialize();
})();
