const express = require('express');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
require('dotenv').config();

const { JsonStore } = require('./lib/json-store');
const {
  bearerToken,
  hmacSha256,
  isValidDeviceId,
  isValidPairingCode,
  isValidSecret,
  normalizePairingCode,
  randomPairingCode,
  randomToken,
  safeHashEquals,
  sha256
} = require('./lib/security');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_ATTEMPTS = 5;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 500;
const MAX_SUBSCRIPTION_ENDPOINT_LENGTH = 2048;
const DISPLAY_NAME_FALLBACK = 'Dispositivo Nugon';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function onlyKeys(object, allowed, required = []) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  const keys = Object.keys(object);
  return keys.every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(object, key));
}

function validSubscription(subscription) {
  if (!onlyKeys(subscription, ['endpoint', 'expirationTime', 'keys'], ['endpoint', 'keys'])) {
    return false;
  }
  if (typeof subscription.endpoint !== 'string'
      || subscription.endpoint.length < 8
      || subscription.endpoint.length > MAX_SUBSCRIPTION_ENDPOINT_LENGTH) return false;
  try {
    if (new URL(subscription.endpoint).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  if (subscription.expirationTime !== null
      && subscription.expirationTime !== undefined
      && (typeof subscription.expirationTime !== 'number'
        || !Number.isFinite(subscription.expirationTime))) return false;
  if (!onlyKeys(subscription.keys, ['p256dh', 'auth'], ['p256dh', 'auth'])) return false;
  return typeof subscription.keys.p256dh === 'string'
    && subscription.keys.p256dh.length >= 16
    && subscription.keys.p256dh.length <= 512
    && typeof subscription.keys.auth === 'string'
    && subscription.keys.auth.length >= 8
    && subscription.keys.auth.length <= 256;
}

function coordinatesFrom(body) {
  const latitudePresent = body.latitude !== undefined && body.latitude !== null;
  const longitudePresent = body.longitude !== undefined && body.longitude !== null;
  if (latitudePresent !== longitudePresent) return { valid: false };
  if (!latitudePresent) return { valid: true, latitude: null, longitude: null };
  if (typeof body.latitude !== 'number' || !Number.isFinite(body.latitude)
      || body.latitude < -90 || body.latitude > 90
      || typeof body.longitude !== 'number' || !Number.isFinite(body.longitude)
      || body.longitude < -180 || body.longitude > 180) return { valid: false };
  return { valid: true, latitude: body.latitude, longitude: body.longitude };
}

function normalizeDisplayName(value, { allowNull = false } = {}) {
  if (value === null && allowNull) return { valid: true, value: null };
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) {
    return { valid: false };
  }
  const normalized = value.trim();
  if (!normalized || [...normalized].length > MAX_DISPLAY_NAME_LENGTH) {
    return { valid: false };
  }
  return { valid: true, value: normalized };
}

function createRateLimiter({ max, windowMs, key, rateLimitSecret, store, now }) {
  return async (request, response, next) => {
    try {
      const currentTime = now();
      const keyHash = hmacSha256(`nugon-rate-limit-v1:${key(request)}`, rateLimitSecret);
      const outcome = await store.update((state) => {
        state.rateLimits = state.rateLimits.filter((item) => item.resetAt > currentTime);
        let bucket = state.rateLimits.find((item) => item.keyHash === keyHash);
        if (!bucket) {
          bucket = { keyHash, count: 0, resetAt: currentTime + windowMs };
          state.rateLimits.push(bucket);
        }
        bucket.count += 1;
        return { limited: bucket.count > max, resetAt: bucket.resetAt };
      });
      if (!outcome.limited) return next();
      response.set('Retry-After', String(Math.max(
        1, Math.ceil((outcome.resetAt - currentTime) / 1000))));
      return response.status(429).json({ error: 'RATE_LIMITED' });
    } catch (error) {
      return next(error);
    }
  };
}

function normalizeTrustProxy(value) {
  if (value === false || value === null || value === undefined || value === '') return false;
  if (typeof value !== 'string') {
    throw new Error('TRUST_PROXY must be an explicit proxy IP, CIDR or named range');
  }
  const normalized = value.trim();
  if (!normalized) return false;
  if (['1', 'true', '*', 'all'].includes(normalized.toLowerCase())) {
    throw new Error('TRUST_PROXY must not trust an arbitrary first hop or every proxy');
  }
  return normalized;
}

function resolveRateLimitSecret({ environment, env = process.env, developmentFallback }) {
  const configured = env.RATE_LIMIT_SECRET;
  if (configured) {
    if (Buffer.byteLength(configured) < 32) {
      throw new Error('RATE_LIMIT_SECRET must contain at least 32 bytes');
    }
    return configured;
  }
  if (environment === 'development' || environment === 'test') {
    if (typeof developmentFallback !== 'string'
        || Buffer.byteLength(developmentFallback) < 32) {
      throw new Error('A development rate limit secret of at least 32 bytes is required');
    }
    return developmentFallback;
  }
  throw new Error(`RATE_LIMIT_SECRET is required when NODE_ENV=${environment}`);
}

function resolveListenHost({ environment, env = process.env }) {
  const configured = typeof env.HOST === 'string' ? env.HOST.trim() : '';
  if (configured) return configured;
  return environment === 'production' ? '127.0.0.1' : '0.0.0.0';
}

function createApp(options) {
  const {
    store,
    pushService,
    vapidPublicKey,
    rateLimitSecret,
    production = false,
    trustProxy = false,
    now = () => Date.now()
  } = options;
  if (typeof rateLimitSecret !== 'string' || Buffer.byteLength(rateLimitSecret) < 32) {
    throw new Error('A rateLimitSecret of at least 32 bytes is required');
  }
  const app = express();
  app.disable('x-powered-by');
  const trustedProxy = normalizeTrustProxy(trustProxy);
  if (trustedProxy) app.set('trust proxy', trustedProxy);

  app.use((request, response, next) => {
    if (production && !request.secure) {
      return response.status(426).json({ error: 'HTTPS_REQUIRED' });
    }
    return next();
  });
  app.use((request, response, next) => {
    response.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; '));
    response.set('Referrer-Policy', 'no-referrer');
    response.set('X-Content-Type-Options', 'nosniff');
    if (production && request.secure) {
      response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  const registrationLimit = createRateLimiter({
    max: 20,
    windowMs: 15 * 60 * 1000,
    key: (request) => `register:${request.ip}`,
    rateLimitSecret,
    store,
    now
  });
  const claimLimit = createRateLimiter({
    max: 20,
    windowMs: 10 * 60 * 1000,
    key: (request) => `claim:${request.ip}`,
    rateLimitSecret,
    store,
    now
  });
  const deviceLimit = createRateLimiter({
    max: 60,
    windowMs: 60 * 1000,
    key: (request) => `device:${request.params.deviceId || request.ip}`,
    rateLimitSecret,
    store,
    now
  });
  const linkLimit = createRateLimiter({
    max: 30,
    windowMs: 10 * 60 * 1000,
    key: (request) => `link:${request.ip}`,
    rateLimitSecret,
    store,
    now
  });

  async function authenticateDevice(request, response, next) {
    const token = bearerToken(request);
    const deviceId = request.params.deviceId;
    if (!isValidDeviceId(deviceId) || !token) {
      return response.status(401).json({ error: 'UNAUTHORIZED' });
    }
    const state = await store.read();
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device || !safeHashEquals(token, device.secretHash)) {
      return response.status(401).json({ error: 'UNAUTHORIZED' });
    }
    request.authenticatedDevice = device;
    return next();
  }

  const asyncRoute = (handler) => (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };

  const api = express.Router();
  api.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/v1/vapid-public-key', (request, response) => {
    response.json({ publicKey: vapidPublicKey });
  });

  api.post('/v1/devices', registrationLimit, asyncRoute(async (request, response) => {
    if (!onlyKeys(request.body, ['deviceId', 'deviceSecret', 'displayName'],
      ['deviceId', 'deviceSecret'])
        || !isValidDeviceId(request.body.deviceId)
        || !isValidSecret(request.body.deviceSecret)) {
      return response.status(400).json({ error: 'INVALID_DEVICE_CREDENTIALS' });
    }
    const displayNamePresent = Object.prototype.hasOwnProperty.call(
      request.body, 'displayName');
    const displayName = displayNamePresent
      ? normalizeDisplayName(request.body.displayName, { allowNull: true })
      : { valid: true, value: null };
    if (!displayName.valid) {
      return response.status(400).json({ error: 'INVALID_DISPLAY_NAME' });
    }
    const { deviceId, deviceSecret } = request.body;
    const result = await store.update((state) => {
      const existing = state.devices.find((item) => item.deviceId === deviceId);
      if (existing) {
        const authenticated = safeHashEquals(deviceSecret, existing.secretHash);
        return {
          existing: true,
          authenticated,
          displayName: existing.displayName || null
        };
      }
      const timestamp = new Date(now()).toISOString();
      state.devices.push({
        deviceId,
        secretHash: sha256(deviceSecret),
        displayName: displayName.value,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      return { existing: false, authenticated: true, displayName: displayName.value };
    });
    if (!result.authenticated) {
      return response.status(409).json({ error: 'DEVICE_ID_ALREADY_REGISTERED' });
    }
    return response.status(result.existing ? 200 : 201).json({
      deviceId,
      displayName: result.displayName,
      registered: !result.existing
    });
  }));

  api.patch('/v1/devices/:deviceId', deviceLimit, asyncRoute(authenticateDevice),
    asyncRoute(async (request, response) => {
      if (!onlyKeys(request.body, ['displayName'], ['displayName'])) {
        return response.status(400).json({ error: 'INVALID_DISPLAY_NAME' });
      }
      const displayName = normalizeDisplayName(request.body.displayName, { allowNull: true });
      if (!displayName.valid) {
        return response.status(400).json({ error: 'INVALID_DISPLAY_NAME' });
      }
      await store.update((state) => {
        const device = state.devices.find(
          (item) => item.deviceId === request.params.deviceId);
        device.displayName = displayName.value;
        device.updatedAt = new Date(now()).toISOString();
      });
      return response.json({
        deviceId: request.params.deviceId,
        displayName: displayName.value
      });
    }));

  api.post('/v1/devices/:deviceId/pairings', deviceLimit, asyncRoute(authenticateDevice),
    asyncRoute(async (request, response) => {
      if (!onlyKeys(request.body, [])) {
        return response.status(400).json({ error: 'INVALID_REQUEST' });
      }
      const code = randomPairingCode();
      const normalizedCode = normalizePairingCode(code);
      const expiresAt = now() + PAIRING_TTL_MS;
      await store.update((state) => {
        state.pairings = state.pairings.filter((item) => item.expiresAt > now());
        state.pairings.push({
          pairingHash: sha256(normalizedCode),
          deviceId: request.params.deviceId,
          createdAt: new Date(now()).toISOString(),
          expiresAt,
          attemptsRemaining: PAIRING_ATTEMPTS,
          usedAt: null,
          blocked: false
        });
      });
      return response.status(201).json({ code, expiresAt });
    }));

  api.post('/v1/pairings/claim', claimLimit, asyncRoute(async (request, response) => {
    if (!onlyKeys(request.body, ['code', 'subscription'], ['code', 'subscription'])
        || !isValidPairingCode(request.body.code)) {
      return response.status(400).json({ error: 'PAIRING_UNAVAILABLE' });
    }
    const pairingHash = sha256(normalizePairingCode(request.body.code));
    const outcome = await store.update((state) => {
      const pairingIndex = state.pairings.findIndex(
        (item) => item.pairingHash === pairingHash);
      if (pairingIndex < 0) return { unavailable: true };
      const pairing = state.pairings[pairingIndex];
      if (pairing.expiresAt <= now()) {
        state.pairings.splice(pairingIndex, 1);
        return { unavailable: true };
      }
      if (pairing.usedAt) return { unavailable: true };
      if (pairing.blocked || pairing.attemptsRemaining <= 0) return { blocked: true };
      pairing.attemptsRemaining -= 1;
      if (!validSubscription(request.body.subscription)) {
        if (pairing.attemptsRemaining <= 0) pairing.blocked = true;
        return { invalid: true, blocked: pairing.blocked };
      }

      const device = state.devices.find((item) => item.deviceId === pairing.deviceId);
      if (!device) return { unavailable: true };

      const linkSecret = randomToken(32);
      const timestamp = new Date(now()).toISOString();
      const existing = state.links.find((item) => item.deviceId === pairing.deviceId
        && item.subscription.endpoint === request.body.subscription.endpoint);
      const linkId = existing ? existing.linkId : `lnk_${randomToken(16)}`;
      const link = {
        linkId,
        deviceId: pairing.deviceId,
        secretHash: sha256(linkSecret),
        subscription: request.body.subscription,
        createdAt: existing ? existing.createdAt : timestamp,
        updatedAt: timestamp
      };
      if (existing) Object.assign(existing, link);
      else state.links.push(link);
      pairing.usedAt = timestamp;
      return {
        linkId,
        linkSecret,
        displayName: device.displayName || DISPLAY_NAME_FALLBACK
      };
    });

    if (outcome.unavailable || outcome.invalid || outcome.blocked) {
      return response.status(400).json({ error: 'PAIRING_UNAVAILABLE' });
    }
    return response.status(201).json({
      linkId: outcome.linkId,
      linkSecret: outcome.linkSecret,
      displayName: outcome.displayName
    });
  }));

  api.post('/v1/devices/:deviceId/alerts', deviceLimit, asyncRoute(authenticateDevice),
    asyncRoute(async (request, response) => {
      if (!onlyKeys(request.body, ['message', 'latitude', 'longitude'], ['message'])
          || typeof request.body.message !== 'string'
          || request.body.message.length < 1
          || request.body.message.length > MAX_MESSAGE_LENGTH) {
        return response.status(400).json({ error: 'INVALID_ALERT' });
      }
      const coordinates = coordinatesFrom(request.body);
      if (!coordinates.valid) {
        return response.status(400).json({ error: 'INVALID_COORDINATES' });
      }

      const state = await store.read();
      const device = state.devices.find((item) => item.deviceId === request.params.deviceId);
      const links = state.links.filter((item) => item.deviceId === request.params.deviceId);
      const payload = {
        title: device && device.displayName
          ? `Alerta de ${device.displayName}`
          : 'Alerta Nugon',
        body: request.body.message,
        timestamp: now(),
        url: '/'
      };
      if (coordinates.latitude !== null) {
        payload.latitude = coordinates.latitude;
        payload.longitude = coordinates.longitude;
        payload.url = `https://maps.google.com/?q=${coordinates.latitude},${coordinates.longitude}`;
      }

      const expiredLinkIds = [];
      const results = await Promise.all(links.map(async (link) => {
        try {
          await pushService.sendNotification(link.subscription, JSON.stringify(payload));
          return true;
        } catch (error) {
          if (error && (error.statusCode === 404 || error.statusCode === 410)) {
            expiredLinkIds.push(link.linkId);
          }
          return false;
        }
      }));
      if (expiredLinkIds.length) {
        await store.update((current) => {
          current.links = current.links.filter((item) => !expiredLinkIds.includes(item.linkId));
        });
      }
      const notifiedCount = results.filter(Boolean).length;
      console.info(`Alert processed; linked=${links.length}, notified=${notifiedCount}`);
      return response.json({ success: true, notifiedCount });
    }));

  api.get('/v1/devices/:deviceId/links', deviceLimit, asyncRoute(authenticateDevice),
    asyncRoute(async (request, response) => {
      const status = await store.update((state) => {
        state.pairings = state.pairings.filter((item) => item.expiresAt > now());
        const links = state.links
          .filter((item) => item.deviceId === request.params.deviceId)
          .map((item) => ({ linkId: item.linkId, createdAt: item.createdAt }));
        const pairingStatuses = state.pairings
          .filter((item) => item.deviceId === request.params.deviceId)
          .map((item) => ({
            expiresAt: item.expiresAt,
            status: item.usedAt ? 'used' : (item.blocked ? 'blocked' : 'active')
          }));
        return { links, pairingStatuses };
      });
      return response.json(status);
    }));

  api.delete('/v1/devices/:deviceId/links', deviceLimit, asyncRoute(authenticateDevice),
    asyncRoute(async (request, response) => {
      const removed = await store.update((state) => {
        const before = state.links.length;
        state.links = state.links.filter((item) => item.deviceId !== request.params.deviceId);
        return before - state.links.length;
      });
      return response.json({ success: true, removed });
    }));

  api.delete('/v1/links/:linkId', linkLimit, asyncRoute(async (request, response) => {
    const token = bearerToken(request);
    if (!token || typeof request.params.linkId !== 'string') {
      return response.status(401).json({ error: 'UNAUTHORIZED' });
    }
    const removed = await store.update((state) => {
      const link = state.links.find((item) => item.linkId === request.params.linkId);
      if (!link || !safeHashEquals(token, link.secretHash)) return false;
      state.links = state.links.filter((item) => item.linkId !== request.params.linkId);
      return true;
    });
    if (!removed) return response.status(401).json({ error: 'UNAUTHORIZED' });
    return response.json({ success: true });
  }));

  api.delete('/v1/devices/:deviceId', deviceLimit, asyncRoute(authenticateDevice),
    asyncRoute(async (request, response) => {
      await store.update((state) => {
        state.devices = state.devices.filter((item) => item.deviceId !== request.params.deviceId);
        state.links = state.links.filter((item) => item.deviceId !== request.params.deviceId);
        state.pairings = state.pairings.filter((item) => item.deviceId !== request.params.deviceId);
      });
      return response.status(204).end();
    }));

  api.use((request, response) => response.status(404).json({ error: 'NOT_FOUND' }));
  app.use('/api', api);

  const staticDir = path.join(__dirname, 'public');
  app.get('/sw.js', (request, response) => {
    response.set('Service-Worker-Allowed', '/');
    response.type('application/javascript');
    response.sendFile(path.join(staticDir, 'sw.js'));
  });
  app.use('/', express.static(staticDir));

  app.use((error, request, response, next) => {
    if (error && (error.type === 'entity.too.large' || error instanceof SyntaxError)) {
      return response.status(400).json({ error: 'INVALID_JSON' });
    }
    console.error(`Unhandled request error: ${error && error.name ? error.name : 'Error'}`);
    return response.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}

function loadVapidConfiguration({ environment, dataDir, env = process.env }) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (Boolean(publicKey) !== Boolean(privateKey)) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must both be configured');
  }
  if (publicKey && privateKey) return { publicKey, privateKey };
  if (environment !== 'development' && environment !== 'test') {
    throw new Error(
      `VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required when NODE_ENV=${environment}`);
  }

  const developmentFile = path.join(dataDir, 'vapid-development.json');
  if (fs.existsSync(developmentFile)) {
    const mode = fs.statSync(developmentFile).mode & 0o777;
    if (mode !== 0o600) throw new Error('Development VAPID file must have mode 0600');
    return JSON.parse(fs.readFileSync(developmentFile, 'utf8'));
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const generated = webpush.generateVAPIDKeys();
  fs.writeFileSync(developmentFile, `${JSON.stringify(generated, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx'
  });
  return generated;
}

async function main() {
  const port = Number(process.env.PORT || 3005);
  const environment = process.env.NODE_ENV || 'development';
  const production = environment === 'production';
  const host = resolveListenHost({ environment });
  const dataDir = path.join(__dirname, 'data');
  const vapid = loadVapidConfiguration({ environment, dataDir });
  const rateLimitSecret = resolveRateLimitSecret({
    environment,
    developmentFallback: vapid.privateKey
  });
  const store = new JsonStore(path.join(dataDir, 'state-v1.json'));
  await store.initialize();
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:soporte@prisma.com.py',
    vapid.publicKey,
    vapid.privateKey
  );
  const app = createApp({
    store,
    pushService: webpush,
    vapidPublicKey: vapid.publicKey,
    rateLimitSecret,
    production,
    trustProxy: process.env.TRUST_PROXY || (production ? 'loopback' : false)
  });
  app.listen(port, host, () => {
    console.info(`Nugon server listening on ${host}:${port}`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Server startup failed: ${error.message || error.name || 'Error'}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  coordinatesFrom,
  loadVapidConfiguration,
  normalizeDisplayName,
  normalizeTrustProxy,
  resolveListenHost,
  resolveRateLimitSecret,
  validSubscription
};
