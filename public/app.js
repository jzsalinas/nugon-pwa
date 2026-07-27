// --------------------------------------------------------------------------
// NUGON SOS PWA - Multi-Family Monitoring & Push Controller
// Scope acotado a /nugon/
// --------------------------------------------------------------------------

(function () {
  'use strict';

  const basePath = '/nugon';
  const apiBase = `${basePath}/api`;

  // Elementos DOM
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const subscribeForm = document.getElementById('subscribeForm');
  const senderIdInput = document.getElementById('senderIdInput');
  const btnSubscribe = document.getElementById('btnSubscribe');
  const monitoredList = document.getElementById('monitoredList');
  const btnTestSound = document.getElementById('btnTestSound');
  const historyList = document.getElementById('historyList');
  const historyFilterSelect = document.getElementById('historyFilterSelect');
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

  if (serverUrlGuide) {
    serverUrlGuide.textContent = `${window.location.origin}${apiBase}/alerta`;
  }

  // --------------------------------------------------------------------------
  // 1. Gestión de Almacenamiento Local (Multi-Familiar)
  // --------------------------------------------------------------------------
  function getMonitoredSenders() {
    // Migración transparente si venía de versión previa con 1 solo sender
    const legacy = localStorage.getItem('nugon_active_sender');
    if (legacy && !localStorage.getItem('nugon_monitored_senders')) {
      const initial = [legacy.trim()];
      localStorage.setItem('nugon_monitored_senders', JSON.stringify(initial));
      localStorage.removeItem('nugon_active_sender');
      return initial;
    }

    try {
      const stored = localStorage.getItem('nugon_monitored_senders');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  }

  function saveMonitoredSenders(list) {
    localStorage.setItem('nugon_monitored_senders', JSON.stringify(list));
    updateStatusPill();
    renderMonitoredList();
    renderHistoryFilterOptions();
  }

  function updateStatusPill() {
    const list = getMonitoredSenders();
    if (list.length > 0) {
      statusPill.classList.add('active');
      statusText.textContent = `Monitoreando ${list.length} familiar${list.length > 1 ? 'es' : ''}`;
    } else {
      statusPill.classList.remove('active');
      statusText.textContent = 'Desconectado';
    }
  }

  // --------------------------------------------------------------------------
  // 2. Inicialización PWA & Service Worker
  // --------------------------------------------------------------------------
  async function initPWA() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      updateStatusPill();
      statusText.textContent = 'Sin soporte Push';
      return;
    }

    try {
      swRegistration = await navigator.serviceWorker.register(`${basePath}/sw.js`, {
        scope: `${basePath}/`
      });
      console.log('[App] Service Worker Nugon SOS registrado con scope:', swRegistration.scope);

      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

      // Renderizar UI inicial
      updateStatusPill();
      renderMonitoredList();
      renderHistoryFilterOptions();
      loadAlertHistory();

      // Comprobar si se abrió por clic en notificación
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
      updateStatusPill();
      statusText.textContent = 'Error de registro';
    }
  }

  // --------------------------------------------------------------------------
  // 3. Renderizar Lista de Familiares Monitoreados
  // --------------------------------------------------------------------------
  function renderMonitoredList() {
    if (!monitoredList) return;

    const list = getMonitoredSenders();

    if (list.length === 0) {
      monitoredList.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: var(--text-muted); background: rgba(17, 24, 39, 0.4); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">👤</div>
          <p style="font-weight: 600; color: var(--text-secondary);">No estás monitoreando a ningún familiar aún.</p>
          <p style="font-size: 0.85rem;">Agrega el nombre de tu familiar abajo para recibir sus notificaciones de auxilio.</p>
        </div>
      `;
      return;
    }

    monitoredList.innerHTML = list.map(sender => `
      <div class="monitored-card">
        <div class="monitored-card-header">
          <div class="monitored-avatar">👤</div>
          <div class="monitored-details">
            <h3 class="monitored-name">${escapeHtml(sender)}</h3>
            <span class="monitored-badge">🟢 Activo</span>
          </div>
        </div>
        <div class="monitored-card-actions">
          <button class="btn btn-secondary btn-test-sender" data-sender="${escapeHtml(sender)}" style="padding: 0.45rem 0.75rem; font-size: 0.825rem;">
            <span>📲</span> Probar Alerta
          </button>
          <button class="btn btn-outline-danger btn-remove-sender" data-sender="${escapeHtml(sender)}" style="padding: 0.45rem 0.75rem; font-size: 0.825rem;">
            <span>🗑️</span> Quitar
          </button>
        </div>
      </div>
    `).join('');

    // Eventos de probador individual
    document.querySelectorAll('.btn-test-sender').forEach(btn => {
      btn.addEventListener('click', () => {
        const sender = btn.getAttribute('data-sender');
        sendTestPushForSender(sender, btn);
      });
    });

    // Eventos de eliminación
    document.querySelectorAll('.btn-remove-sender').forEach(btn => {
      btn.addEventListener('click', () => {
        const sender = btn.getAttribute('data-sender');
        removeSender(sender);
      });
    });
  }

  // --------------------------------------------------------------------------
  // 4. Agregar / Eliminar Familiar
  // --------------------------------------------------------------------------
  subscribeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const senderId = senderIdInput.value.trim();
    if (!senderId) return;

    const currentList = getMonitoredSenders();
    if (currentList.some(s => s.toLowerCase() === senderId.toLowerCase())) {
      alert(`Ya estás monitoreando a "${senderId}".`);
      senderIdInput.value = '';
      return;
    }

    try {
      btnSubscribe.disabled = true;
      btnSubscribe.textContent = 'Solicitando permisos...';

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('Debes conceder permiso de notificaciones para poder recibir alertas.');
        btnSubscribe.disabled = false;
        return;
      }

      btnSubscribe.textContent = 'Conectando con el servidor...';

      const response = await fetch(`${apiBase}/vapid-public-key`);
      const data = await response.json();
      const applicationServerKey = urlBase64ToUint8Array(data.publicKey);

      let subscription = await swRegistration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey
        });
      }

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
        const updatedList = [...currentList, senderId];
        saveMonitoredSenders(updatedList);
        senderIdInput.value = '';
        alert(`✅ ¡Monitoreo activado para "${senderId}"!`);
      } else {
        throw new Error(resData.error || 'Error al suscribir');
      }

    } catch (err) {
      console.error('[App] Error al agregar familiar:', err);
      alert('❌ Error al activar monitoreo: ' + err.message);
    } finally {
      btnSubscribe.disabled = false;
      btnSubscribe.innerHTML = '<span>🔔</span> Activar Alerta para este Familiar';
    }
  });

  async function removeSender(senderId) {
    if (!confirm(`¿Deseas dejar de recibir alertas para "${senderId}"?`)) return;

    try {
      const sub = await swRegistration.pushManager.getSubscription();
      if (sub) {
        await fetch(`${apiBase}/unsubscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint, sender_id: senderId })
        });
      }

      const currentList = getMonitoredSenders();
      const updatedList = currentList.filter(s => s.toLowerCase() !== senderId.toLowerCase());
      saveMonitoredSenders(updatedList);

      // Si no quedan familiares, desuscribir del PushManager de forma limpia
      if (updatedList.length === 0 && sub) {
        await sub.unsubscribe();
      }

      alert(`Se ha dejado de monitorear a "${senderId}".`);
    } catch (err) {
      console.error(err);
      alert('Error al quitar familiar: ' + err.message);
    }
  }

  // --------------------------------------------------------------------------
  // 5. Sirena de Audio y Pruebas
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

  async function sendTestPushForSender(senderId, btnElement) {
    try {
      const sub = await swRegistration.pushManager.getSubscription();
      if (!sub) {
        alert('No hay suscripción Push activa.');
        return;
      }

      if (btnElement) {
        btnElement.disabled = true;
        btnElement.textContent = 'Enviando...';
      }

      await fetch(`${apiBase}/test-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender_id: senderId, subscription: sub })
      });

      alert(`🔔 Notificación de prueba enviada para "${senderId}".`);
    } catch (e) {
      alert('Error en la prueba: ' + e.message);
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.innerHTML = '<span>📲</span> Probar Alerta';
      }
    }
  }

  // --------------------------------------------------------------------------
  // 6. Overlay de Emergencia en Pantalla Completa
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
  // 7. Historial de Alertas y Filtro
  // --------------------------------------------------------------------------
  function renderHistoryFilterOptions() {
    if (!historyFilterSelect) return;
    const list = getMonitoredSenders();

    let html = '<option value="">Todos los familiares</option>';
    list.forEach(sender => {
      html += `<option value="${escapeHtml(sender)}">${escapeHtml(sender)}</option>`;
    });

    historyFilterSelect.innerHTML = html;
  }

  if (historyFilterSelect) {
    historyFilterSelect.addEventListener('change', () => {
      loadAlertHistory();
    });
  }

  async function loadAlertHistory() {
    if (!historyList) return;

    const filterSender = historyFilterSelect ? historyFilterSelect.value : '';
    const query = filterSender ? `?sender_id=${encodeURIComponent(filterSender)}` : '';

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
  // 8. Navegación por Tabs
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
