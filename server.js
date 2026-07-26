const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3005;
const BASE_PATH = (process.env.BASE_PATH || '/nugon').replace(/\/$/, '');

// Middleware
app.use(cors());
app.use(express.json());

// Directorio de almacenamiento de datos
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'database.json');
const VAPID_KEYS_FILE = path.join(DATA_DIR, 'vapid.json');

// Cargar o Inicializar VAPID Keys
let vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
let vapidSubject = process.env.VAPID_SUBJECT || 'mailto:soporte@prisma.com.py';

if (!vapidPublicKey || !vapidPrivateKey) {
  if (fs.existsSync(VAPID_KEYS_FILE)) {
    try {
      const keys = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, 'utf8'));
      vapidPublicKey = keys.publicKey;
      vapidPrivateKey = keys.privateKey;
    } catch (e) {
      console.error('Error leyendo VAPID keys:', e);
    }
  }

  if (!vapidPublicKey || !vapidPrivateKey) {
    console.log('⚡ Generando nuevas llaves VAPID para Web Push...');
    const vapidKeys = webpush.generateVAPIDKeys();
    vapidPublicKey = vapidKeys.publicKey;
    vapidPrivateKey = vapidKeys.privateKey;
    fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(vapidKeys, null, 2));
    console.log('✅ Llaves VAPID generadas y guardadas en data/vapid.json');
  }
}

webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

// Inicializar Base de Datos Simple
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialDB = { subscribers: [], alerts: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2));
    return initialDB;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('Error cargando DB, reiniciando:', err);
    return { subscribers: [], alerts: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Normalizar identificador emisor
function normalizeSenderId(id) {
  return (id || '').toString().trim().toLowerCase();
}

// Router API
const apiRouter = express.Router();

// 1. Obtener llave pública VAPID
apiRouter.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey, basePath: BASE_PATH });
});

// 2. Suscribir familiar a un Sender ID
apiRouter.post('/subscribe', (req, res) => {
  const { sender_id, subscription } = req.body;

  if (!sender_id || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'sender_id y subscription son requeridos.' });
  }

  const normId = normalizeSenderId(sender_id);
  const db = loadDB();

  const existingIndex = db.subscribers.findIndex(
    sub => sub.endpoint === subscription.endpoint && normalizeSenderId(sub.sender_id) === normId
  );

  const subData = {
    id: Date.now().toString(),
    sender_id: sender_id.trim(),
    norm_sender_id: normId,
    endpoint: subscription.endpoint,
    subscription: subscription,
    created_at: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    db.subscribers[existingIndex] = subData;
  } else {
    db.subscribers.push(subData);
  }

  saveDB(db);
  console.log(`📌 Nuevo familiar suscrito a [${sender_id.trim()}] (${db.subscribers.length} suscripciones totales)`);

  res.status(201).json({ success: true, message: 'Suscripción registrada exitosamente.' });
});

// 3. Desuscribir
apiRouter.post('/unsubscribe', (req, res) => {
  const { endpoint, sender_id } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint es requerido.' });
  }

  const db = loadDB();
  const initialLength = db.subscribers.length;
  
  if (sender_id) {
    const normId = normalizeSenderId(sender_id);
    db.subscribers = db.subscribers.filter(
      sub => !(sub.endpoint === endpoint && normalizeSenderId(sub.sender_id) === normId)
    );
  } else {
    db.subscribers = db.subscribers.filter(sub => sub.endpoint !== endpoint);
  }

  saveDB(db);
  res.json({ success: true, removed: initialLength - db.subscribers.length });
});

// 4. Endpoint de Alerta (Llamado por la App Android o pruebas)
apiRouter.post('/alerta', async (req, res) => {
  const { sender_id, message, latitude, longitude } = req.body;

  if (!sender_id) {
    return res.status(400).json({ error: 'El campo sender_id es obligatorio.' });
  }

  const normId = normalizeSenderId(sender_id);
  const db = loadDB();

  const targetSubscribers = db.subscribers.filter(
    sub => normalizeSenderId(sub.sender_id) === normId
  );

  const mapsUrl = (latitude && longitude)
    ? `https://maps.google.com/?q=${latitude},${longitude}`
    : null;

  const alertRecord = {
    id: 'alt_' + Date.now(),
    sender_id: sender_id.trim(),
    message: message || `¡ALERTA DE EMERGENCIA de ${sender_id}!`,
    latitude: latitude || null,
    longitude: longitude || null,
    maps_url: mapsUrl,
    timestamp: Date.now(),
    created_at: new Date().toISOString(),
    subscribers_notified: targetSubscribers.length
  };

  db.alerts.unshift(alertRecord);
  if (db.alerts.length > 100) db.alerts = db.alerts.slice(0, 100);
  saveDB(db);

  console.log(`🚨 ¡ALERTA RECIBIDA DE [${sender_id}]! Notificando a ${targetSubscribers.length} familiares...`);

  const payload = JSON.stringify({
    title: `🚨 ¡ALERTA DE EMERGENCIA: ${sender_id}!`,
    body: message || `¡Necesito ayuda urgente! Revisa mi ubicación.`,
    sender_id: sender_id.trim(),
    latitude: latitude,
    longitude: longitude,
    url: mapsUrl || `${BASE_PATH}/`,
    timestamp: alertRecord.timestamp
  });

  const pushPromises = targetSubscribers.map(async (sub) => {
    try {
      await webpush.sendNotification(sub.subscription, payload);
      return { success: true, id: sub.id };
    } catch (error) {
      console.error(`❌ Error enviando push a sub ${sub.id}:`, error.statusCode || error.message);
      if (error.statusCode === 404 || error.statusCode === 410) {
        return { remove: true, endpoint: sub.endpoint };
      }
      return { success: false, error: error.message };
    }
  });

  const results = await Promise.all(pushPromises);
  
  const endpointsToRemove = results.filter(r => r.remove).map(r => r.endpoint);
  if (endpointsToRemove.length > 0) {
    const updatedDb = loadDB();
    updatedDb.subscribers = updatedDb.subscribers.filter(sub => !endpointsToRemove.includes(sub.endpoint));
    saveDB(updatedDb);
    console.log(`🧹 Eliminadas ${endpointsToRemove.length} suscripciones expiradas.`);
  }

  res.status(200).json({
    success: true,
    message: `Alerta procesada y notificaciones enviadas.`,
    notified_count: targetSubscribers.length,
    alert: alertRecord
  });
});

// 5. Alerta de prueba desde PWA
apiRouter.post('/test-alert', async (req, res) => {
  const { sender_id, subscription } = req.body;
  if (!subscription) {
    return res.status(400).json({ error: 'Subscription es requerida.' });
  }

  const payload = JSON.stringify({
    title: `🔔 Prueba de Alerta Nugon SOS`,
    body: `El sistema de notificaciones está configurado y funcionando correctamente para ${sender_id || 'tu dispositivo'}.`,
    sender_id: sender_id || 'Prueba',
    url: `${BASE_PATH}/`,
    is_test: true,
    timestamp: Date.now()
  });

  try {
    await webpush.sendNotification(subscription, payload);
    res.json({ success: true, message: 'Alerta de prueba enviada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Obtener historial de alertas
apiRouter.get('/alerts', (req, res) => {
  const { sender_id } = req.query;
  const db = loadDB();
  if (sender_id) {
    const normId = normalizeSenderId(sender_id);
    const filtered = db.alerts.filter(a => normalizeSenderId(a.sender_id) === normId);
    return res.json(filtered);
  }
  res.json(db.alerts.slice(0, 30));
});

// 7. Conteo de familiares suscritos
apiRouter.get('/subscribers-count', (req, res) => {
  const { sender_id } = req.query;
  const db = loadDB();
  if (sender_id) {
    const normId = normalizeSenderId(sender_id);
    const count = db.subscribers.filter(s => normalizeSenderId(s.sender_id) === normId).length;
    return res.json({ sender_id, count });
  }
  res.json({ total: db.subscribers.length });
});

// Montar API en rutas /api y /nugon/api
app.use(`${BASE_PATH}/api`, apiRouter);
app.use('/api', apiRouter);

// Servir sw.js con cabecera de acotamiento de Service Worker
app.get(['/nugon/sw.js', '/sw.js'], (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/nugon/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Archivos Estáticos PWA
const staticDir = path.join(__dirname, 'public');
app.use(BASE_PATH, express.static(staticDir));
app.use('/', express.static(staticDir));

// Fallback SPA
app.get(`${BASE_PATH}/*`, (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.get('/*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚨 NUGON SOS PWA SERVER CORRIENDO EN PUERTO ${PORT}`);
  console.log(`==================================================`);
  console.log(`📍 Ruta Base Web PWA: http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`📍 Scope SW Acotado: ${BASE_PATH}/`);
  console.log(`📍 Endpoint Android API: http://localhost:${PORT}${BASE_PATH}/api/alerta`);
  console.log(`🔑 VAPID Public Key: ${vapidPublicKey}`);
  console.log(`==================================================\n`);
});
