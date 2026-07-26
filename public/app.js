// --------------------------------------------------------------------------
// NUGON SOS PWA - App Logic & Web Push Controller
// Aislamiento estricto de Scope PWA en /nugon/
// --------------------------------------------------------------------------

(function () {
  'use strict';

  // Forzar /nugon como base path de la PWA para evitar sobreescribir la PWA raíz de Prisma
  const basePath = '/nugon';
  const apiBase = `${basePath}/api`;

  // Elementos DOM
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const subscribeForm = document.getElementById('subscribeForm');
  const senderIdInput = document.getElementById('senderIdInput');
  const btnSubscribe = document.getElementById('btnSubscribe');
  const activeBanner = document.getElementById('activeBanner');
  const activeSenderLabel = document.getElementById('activeSenderLabel');
  const btnUnsubscribe = document.getElementById('btnUnsubscribe');
  const btnTestSound = document.getElementById('btnTestSound');
  const btnTestPush = document.getElementById('btnTestPush');
  const historyList = document.getElementById('historyList');
  const serverUrlGuide = document.getElementById('serverUrlGuide');
  
  // Overlay de Emergencia
  const alertOverlay = document.getElementById('alertOverlay');
  const alertSenderTitle = document.getElementById('alertSenderTitle');
  const alertBodyText = document.getElementById('alertBodyText');
  const alertTimeText = document.getElementById('alertTimeText');
  const btnOpenMaps = document.getElementById('btnOpenMaps');
  const btnSilenceAlarm = document.getElementById('btnSilenceAlarm');

  let swRegistration = null;
  let audioContext = null;
  let sirenOscillator1 = null;
  let sirenTimer = null;

  // Actualizar Guía URL
  if (serverUrlGuide) {
    serverUrlGuide.textContent = `${window.location.origin}${apiBase}/alerta`;
  }

  // --------------------------------------------------------------------------
  // 1. Inicialización de Service Worker con Scope /nugon/
  // --------------------------------------------------------------------------
  async function initPWA() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      updateStatus(false, 'Navegador sin soporte Push');
      return;
    }

    try {
      // Registrar el Service Worker explícitamente acotado al scope /nugon/
      swRegistration = await navigator.serviceWorker.register(`${basePath}/sw.js`, {
        scope: `${basePath}/`
      });
      console.log('[App] Service Worker Nugon SOS registrado con scope:', swRegistration.scope);

      // Escuchar mensajes del Service Worker
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

      // Verificar suscripción guardada
      const savedSender = localStorage.getItem('nugon_active_sender');
      if (savedSender) {
        senderIdInput.value = savedSender;
        checkExistingSubscription(savedSender);
      } else {
        updateStatus(false, 'No registrado');
      }

      // Cargar historial
      loadAlertHistory();

      // Comprobar parámetros de URL (si se abrió por clic en notificación)
      const urlParams = new URLSearchParams(window.location.search);
      const alertParam = urlParams.get('alert');
      if (alertParam) {
        try {
          const alertData = JSON.parse(decodeURIComponent(alertParam));
          triggerEmergencyOverlay(alertData);
        } catch (e) {
          console.error(e);
        }
      }

    } catch (err) {
      console.error('[App] Error al registrar Service Worker:', err);
      updateStatus(false, 'Error de registro SW');
    }
  }

  // --------------------------------------------------------------------------
  // 2. Manejo de Estado de Suscripción
  // --------------------------------------------------------------------------
  async function checkExistingSubscription(senderId) {
    if (!swRegistration) return;
    const sub = await swRegistration.pushManager.getSubscription();
    if (sub) {
      showSubscribedUI(senderId);
      updateStatus(true, `Conectado: ${senderId}`);
    } else {
      showUnsubscribedUI();
      updateStatus(false, 'Desconectado');
    }
  }

  function updateStatus(active, text) {
    if (active) {
      statusPill.classList.add('active');
    } else {
      statusPill.classList.remove('active');
    }
    statusText.textContent = text;
  }

  function showSubscribedUI(senderId) {
    activeSenderLabel.textContent = senderId;
    activeBanner.style.display = 'flex';
    btnSubscribe.textContent = '🔄 Actualizar Suscripción';
  }

  function showUnsubscribedUI() {
    activeBanner.style.display = 'none';
    btnSubscribe.innerHTML = '<span>🔔</span> Activar Notificaciones en este Celular';
  }

  // --------------------------------------------------------------------------
  // 3. Proceso de Suscripción Web Push
  // --------------------------------------------------------------------------
  subscribeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const senderId = senderIdInput.value.trim();
    if (!senderId) return;

    try {
      btnSubscribe.disabled = true;
      btnSubscribe.textContent = 'Obteniendo permisos...';

      // Solicitar permiso de Notificación
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('Debes conceder permiso de notificaciones para poder recibir las alertas de emergencia.');
        btnSubscribe.disabled = false;
        showUnsubscribedUI();
        return;
      }

      btnSubscribe.textContent = 'Conectando con el servidor...';

      // Obtener llave pública VAPID
      const response = await fetch(`${apiBase}/vapid-public-key`);
      const data = await response.json();
      const applicationServerKey = urlBase64ToUint8Array(data.publicKey);

      // Crear o recuperar suscripción Web Push
      let subscription = await swRegistration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey
        });
      }

      // Enviar al Backend
      const res = await fetch(`${apiBase}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_id: senderId,
          subscription: subscription
        })
      });

      const resData = await res.json();

      if (resData.success) {
        localStorage.setItem('nugon_active_sender', senderId);
        showSubscribedUI(senderId);
        updateStatus(true, `Conectado: ${senderId}`);
        alert(`✅ ¡Notificaciones activadas! Ahora este celular sonará cuando ${senderId} emita una alerta.`);
      } else {
        throw new Error(resData.error || 'Error al guardar la suscripción');
      }

    } catch (err) {
      console.error('[App] Error al suscribirse:', err);
      alert('❌ Error al configurar notificaciones: ' + err.message);
    } finally {
      btnSubscribe.disabled = false;
    }
  });

  // Desuscribir
  btnUnsubscribe.addEventListener('click', async () => {
    if (!confirm('¿Deseas dejar de recibir alertas de emergencia en este celular?')) return;

    try {
      const sub = await swRegistration.pushManager.getSubscription();
      const senderId = localStorage.getItem('nugon_active_sender');
      
      if (sub) {
        await fetch(`${apiBase}/unsubscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint, sender_id: senderId })
        });
        await sub.unsubscribe();
      }

      localStorage.removeItem('nugon_active_sender');
      showUnsubscribedUI();
      updateStatus(false, 'Desconectado');
      alert('Suscripción cancelada.');
    } catch (err) {
      console.error(err);
    }
  });

  // --------------------------------------------------------------------------
  // 4. Sirena de Audio (Web Audio API) y Alerta
  // --------------------------------------------------------------------------
  function startEmergencySiren() {
    stopEmergencySiren();

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioCtx();

      sirenOscillator1 = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      sirenOscillator1.type = 'sawtooth';
      sirenOscillator1.frequency.setValueAtTime(960, audioContext.currentTime);

      gainNode.gain.setValueAtTime(0.8, audioContext.currentTime);

      sirenOscillator1.connect(gainNode);
      gainNode.connect(audioContext.destination);

      sirenOscillator1.start();

      let highTone = true;
      sirenTimer = setInterval(() => {
        if (!audioContext || audioContext.state === 'closed') return;
        highTone = !highTone;
        sirenOscillator1.frequency.setValueAtTime(
          highTone ? 960 : 770,
          audioContext.currentTime
        );
      }, 400);

      if (navigator.vibrate) {
        navigator.vibrate([500, 110, 500, 110, 500, 110, 500, 110, 1000]);
      }
    } catch (e) {
      console.error('[App] Error al iniciar sirena de audio:', e);
    }
  }

  function stopEmergencySiren() {
    if (sirenTimer) {
      clearInterval(sirenTimer);
      sirenTimer = null;
    }
    if (sirenOscillator1) {
      try { sirenOscillator1.stop(); } catch (e) {}
      sirenOscillator1 = null;
    }
    if (audioContext) {
      try { audioContext.close(); } catch (e) {}
      audioContext = null;
    }
    if (navigator.vibrate) {
      navigator.vibrate(0);
    }
  }

  btnTestSound.addEventListener('click', () => {
    startEmergencySiren();
    setTimeout(() => {
      stopEmergencySiren();
    }, 4000);
  });

  btnTestPush.addEventListener('click', async () => {
    try {
      const sub = await swRegistration.pushManager.getSubscription();
      const senderId = localStorage.getItem('nugon_active_sender') || 'Prueba';
      if (!sub) {
        alert('Debes activar las notificaciones primero.');
        return;
      }
      btnTestPush.disabled = true;
      btnTestPush.textContent = 'Enviando...';

      await fetch(`${apiBase}/test-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender_id: senderId, subscription: sub })
      });

      alert('🔔 Notificación de prueba enviada. Debería sonar e indicarte la prueba.');
    } catch (e) {
      alert('Error en la prueba: ' + e.message);
    } finally {
      btnTestPush.disabled = false;
      btnTestPush.innerHTML = '<span>📲</span> Enviar Notificación de Prueba';
    }
  });

  // --------------------------------------------------------------------------
  // 5. Overlay de Emergencia en Pantalla Completa
  // --------------------------------------------------------------------------
  function triggerEmergencyOverlay(data) {
    startEmergencySiren();

    alertSenderTitle.textContent = `🚨 ¡ALERTA: ${data.sender_id || 'EMERGENCIA'}!`;
    alertBodyText.textContent = data.body || data.message || '¡Auxilio solicitado! Revisa la posición GPS.';

    const timeStr = data.timestamp 
      ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : new Date().toLocaleTimeString();
    alertTimeText.textContent = `Recibido a las: ${timeStr}`;

    const mapsUrl = data.url || (data.latitude && data.longitude ? `https://maps.google.com/?q=${data.latitude},${data.longitude}` : '#');
    btnOpenMaps.href = mapsUrl;

    alertOverlay.classList.remove('hidden');

    loadAlertHistory();
  }

  btnSilenceAlarm.addEventListener('click', () => {
    stopEmergencySiren();
    alertOverlay.classList.add('hidden');
  });

  function handleServiceWorkerMessage(event) {
    if (event.data && event.data.type === 'EMERGENCY_ALERT') {
      triggerEmergencyOverlay(event.data.data);
    }
  }

  // --------------------------------------------------------------------------
  // 6. Historial de Alertas
  // --------------------------------------------------------------------------
  async function loadAlertHistory() {
    if (!historyList) return;
    const senderId = localStorage.getItem('nugon_active_sender');
    const query = senderId ? `?sender_id=${encodeURIComponent(senderId)}` : '';

    try {
      const res = await fetch(`${apiBase}/alerts${query}`);
      const alerts = await res.json();

      if (!alerts || alerts.length === 0) {
        historyList.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 2rem;">No hay alertas registradas aún.</p>';
        return;
      }

      historyList.innerHTML = alerts.map(a => {
        const timeFormatted = new Date(a.timestamp || a.created_at).toLocaleString();
        return `
          <div class="history-item">
            <div class="history-info">
              <div class="history-sender">🚨 ${escapeHtml(a.sender_id)}</div>
              <div class="history-msg">${escapeHtml(a.message)}</div>
              <div class="history-date">📅 ${timeFormatted}</div>
            </div>
            ${a.maps_url ? `
              <a href="${a.maps_url}" target="_blank" class="btn btn-secondary" style="width: auto; padding: 0.5rem 0.85rem; font-size: 0.85rem;">
                📍 Google Maps
              </a>
            ` : ''}
          </div>
        `;
      }).join('');

    } catch (err) {
      console.error(err);
      historyList.innerHTML = '<p style="text-align: center; color: var(--accent-red); padding: 1.5rem;">Error al cargar el historial.</p>';
    }
  }

  function escapeHtml(str) {
    return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // --------------------------------------------------------------------------
  // 7. Navegación por Tabs
  // --------------------------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(btn.getAttribute('data-tab'));
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      if (btn.getAttribute('data-tab') === 'tab-historial') {
        loadAlertHistory();
      }
    });
  });

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  window.addEventListener('DOMContentLoaded', initPWA);

})();
