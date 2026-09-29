const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const { JsonStore } = require('../lib/json-store');
const { hmacSha256, randomToken, sha256 } = require('../lib/security');
const {
  createApp,
  loadVapidConfiguration,
  normalizeTrustProxy,
  resolveRateLimitSecret
} = require('../server');

const TEST_RATE_LIMIT_SECRET = 'test-rate-limit-secret-with-at-least-32-bytes';

const subscription = {
  endpoint: 'https://push.example.test/subscription/abc123',
  expirationTime: null,
  keys: {
    p256dh: 'B'.repeat(88),
    auth: 'A'.repeat(24)
  }
};

let fixture;

async function createFixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nugon-api-test-'));
  const stateFile = path.join(directory, 'state-v1.json');
  const store = new JsonStore(stateFile);
  await store.initialize();
  let currentTime = Date.now();
  const pushes = [];
  const pushService = {
    async sendNotification(target, payload) {
      pushes.push({ target, payload: JSON.parse(payload) });
    }
  };
  const app = createApp({
    store,
    pushService,
    vapidPublicKey: 'test-public-key',
    rateLimitSecret: TEST_RATE_LIMIT_SECRET,
    production: options.production || false,
    trustProxy: options.trustProxy || false,
    now: () => currentTime
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  return {
    directory,
    stateFile,
    store,
    pushes,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    advance(milliseconds) { currentTime += milliseconds; }
  };
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${fixture.baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function credentials() {
  return { deviceId: randomToken(16), deviceSecret: randomToken(32) };
}

function auth(secret) {
  return { Authorization: `Bearer ${secret}` };
}

async function register(device = credentials()) {
  const result = await api('/api/v1/devices', { method: 'POST', body: device });
  assert.equal(result.response.status, 201);
  return device;
}

async function createPairing(device) {
  const result = await api(`/api/v1/devices/${device.deviceId}/pairings`, {
    method: 'POST',
    headers: auth(device.deviceSecret),
    body: {}
  });
  assert.equal(result.response.status, 201);
  return result.body;
}

async function claim(code, pushSubscription = subscription) {
  return api('/api/v1/pairings/claim', {
    method: 'POST',
    body: { code, subscription: pushSubscription }
  });
}

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  await new Promise((resolve) => fixture.server.close(resolve));
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('registro válido guarda sólo el hash del secreto', async () => {
  const device = await register();
  const state = await fixture.store.read();
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].deviceId, device.deviceId);
  assert.notEqual(state.devices[0].secretHash, device.deviceSecret);
  assert.equal(state.devices[0].secretHash.length, 64);
});

test('rate limit persiste sólo clave opaca, contador y expiración', async () => {
  await register();
  const state = await fixture.store.read();
  assert.equal(state.rateLimits.length, 1);
  assert.deepEqual(Object.keys(state.rateLimits[0]).sort(), ['count', 'keyHash', 'resetAt']);
  assert.match(state.rateLimits[0].keyHash, /^[a-f0-9]{64}$/);
  const rawKeys = ['register:127.0.0.1', 'register:::ffff:127.0.0.1'];
  const expectedHmacs = rawKeys.map((key) => hmacSha256(
    `nugon-rate-limit-v1:${key}`, TEST_RATE_LIMIT_SECRET));
  assert.ok(expectedHmacs.includes(state.rateLimits[0].keyHash));
  for (const key of rawKeys) assert.notEqual(state.rateLimits[0].keyHash, sha256(key));
  const raw = await fs.readFile(fixture.stateFile, 'utf8');
  assert.equal(raw.includes('127.0.0.1'), false);
});

test('rate limit elimina entradas vencidas antes de persistir el siguiente bucket', async () => {
  const device = await register();
  fixture.advance(16 * 60 * 1000);
  const duplicate = await api('/api/v1/devices', { method: 'POST', body: device });
  assert.equal(duplicate.response.status, 200);
  const state = await fixture.store.read();
  assert.equal(state.rateLimits.length, 1);
  assert.equal(state.rateLimits[0].count, 1);
});

test('registro duplicado es idempotente con el mismo secreto', async () => {
  const device = await register();
  const duplicate = await api('/api/v1/devices', { method: 'POST', body: device });
  assert.equal(duplicate.response.status, 200);
  assert.equal((await fixture.store.read()).devices.length, 1);
});

test('un tercero no puede reemplazar el secreto de un deviceId', async () => {
  const device = await register();
  const replacement = await api('/api/v1/devices', {
    method: 'POST',
    body: { deviceId: device.deviceId, deviceSecret: randomToken(32) }
  });
  assert.equal(replacement.response.status, 409);
});

test('secreto incorrecto no autentica', async () => {
  const device = await register();
  const result = await api(`/api/v1/devices/${device.deviceId}/pairings`, {
    method: 'POST',
    headers: auth(randomToken(32)),
    body: {}
  });
  assert.equal(result.response.status, 401);
});

test('dispositivo autenticado crea pairing temporal hasheado', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  assert.match(pairing.code, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  const state = await fixture.store.read();
  assert.equal(state.pairings.length, 1);
  assert.equal(state.pairings[0].pairingHash.length, 64);
  assert.equal(JSON.stringify(state).includes(pairing.code.replaceAll('-', '')), false);
});

test('pairing expirado no puede reclamarse', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  fixture.advance(10 * 60 * 1000 + 1);
  const result = await claim(pairing.code);
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, 'PAIRING_UNAVAILABLE');
});

test('pairing es de un solo uso', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  assert.equal((await claim(pairing.code)).response.status, 201);
  assert.equal((await claim(pairing.code)).response.status, 400);
});

test('pairing se bloquea tras intentos excesivos', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  const invalidSubscription = { ...subscription, keys: { p256dh: 'short', auth: 'short' } };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await claim(pairing.code, invalidSubscription)).response.status, 400);
  }
  assert.equal((await claim(pairing.code, invalidSubscription)).response.status, 400);
  const blocked = await claim(pairing.code);
  assert.equal(blocked.response.status, 400);
  assert.equal(blocked.body.error, 'PAIRING_UNAVAILABLE');
});

test('claim válido crea un vínculo y devuelve credencial revocable', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  const result = await claim(pairing.code);
  assert.equal(result.response.status, 201);
  assert.match(result.body.linkId, /^lnk_/);
  assert.ok(result.body.linkSecret.length >= 43);
  const state = await fixture.store.read();
  assert.equal(state.links.length, 1);
  assert.notEqual(state.links[0].secretHash, result.body.linkSecret);
});

test('alerta sin autenticación es rechazada', async () => {
  const device = await register();
  const result = await api(`/api/v1/devices/${device.deviceId}/alerts`, {
    method: 'POST',
    body: { message: 'Ayuda' }
  });
  assert.equal(result.response.status, 401);
});

test('alerta autenticada notifica sólo vínculos del dispositivo', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  await claim(pairing.code);
  const result = await api(`/api/v1/devices/${device.deviceId}/alerts`, {
    method: 'POST',
    headers: auth(device.deviceSecret),
    body: { message: 'Ayuda', latitude: 0, longitude: 0 }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.notifiedCount, 1);
  assert.equal(fixture.pushes.length, 1);
  assert.equal(fixture.pushes[0].payload.latitude, 0);
  assert.equal(fixture.pushes[0].payload.longitude, 0);
});

test('alerta sin ubicación omite coordenadas y sigue enviándose', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  await claim(pairing.code);
  const result = await api(`/api/v1/devices/${device.deviceId}/alerts`, {
    method: 'POST',
    headers: auth(device.deviceSecret),
    body: { message: 'Ayuda sin GPS' }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.notifiedCount, 1);
  assert.equal('latitude' in fixture.pushes[0].payload, false);
  assert.equal('longitude' in fixture.pushes[0].payload, false);
});

test('coordenadas inválidas son rechazadas', async () => {
  const device = await register();
  const result = await api(`/api/v1/devices/${device.deviceId}/alerts`, {
    method: 'POST',
    headers: auth(device.deviceSecret),
    body: { message: 'Ayuda', latitude: 91, longitude: 0 }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, 'INVALID_COORDINATES');
});

test('familiar puede desvincularse con linkSecret', async () => {
  const device = await register();
  const pairing = await createPairing(device);
  const linked = await claim(pairing.code);
  const result = await api(`/api/v1/links/${linked.body.linkId}`, {
    method: 'DELETE',
    headers: auth(linked.body.linkSecret)
  });
  assert.equal(result.response.status, 200);
  assert.equal((await fixture.store.read()).links.length, 0);
});

test('endpoints legacy no existen', async () => {
  const legacyPaths = [
    '/api/alerts',
    '/api/subscribers-count',
    '/api/subscribe',
    '/api/unsubscribe',
    '/api/test-alert',
    '/api/alerta'
  ];
  for (const pathname of legacyPaths) {
    const method = pathname.includes('alerts') ? 'GET' : 'POST';
    const result = await api(pathname, method === 'GET'
      ? { method }
      : { method, body: {} });
    assert.equal(result.response.status, 404, pathname);
  }
});

test('una alerta no crea historial ni persiste contenido o ubicación', async () => {
  const device = await register();
  const privateMessage = `private-${randomToken(12)}`;
  const result = await api(`/api/v1/devices/${device.deviceId}/alerts`, {
    method: 'POST',
    headers: auth(device.deviceSecret),
    body: { message: privateMessage, latitude: -25.3, longitude: -57.6 }
  });
  assert.equal(result.response.status, 200);
  const raw = await fs.readFile(fixture.stateFile, 'utf8');
  assert.equal(raw.includes(privateMessage), false);
  assert.equal(raw.includes('latitude'), false);
  assert.equal(raw.includes('longitude'), false);
  assert.equal(raw.includes('alerts'), false);
});

test('API mismo origen no habilita CORS global', async () => {
  const result = await api('/api/v1/vapid-public-key');
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.has('access-control-allow-origin'), false);
});

test('PWA, manifest, Service Worker y API se sirven desde la raíz oficial', async () => {
  const root = await fetch(`${fixture.baseUrl}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);

  const manifestResponse = await fetch(`${fixture.baseUrl}/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');

  const workerResponse = await fetch(`${fixture.baseUrl}/sw.js`);
  assert.equal(workerResponse.status, 200);
  assert.equal(workerResponse.headers.get('service-worker-allowed'), '/');
  assert.equal((await workerResponse.text()).includes('/nugon'), false);

  const apiResponse = await api('/api/v1/vapid-public-key');
  assert.equal(apiResponse.response.status, 200);
  const oldOriginPath = await fetch(`${fixture.baseUrl}/nugon/`);
  assert.equal(oldOriginPath.status, 404);
});

test('producción rechaza HTTP sin proxy HTTPS confiable', async () => {
  await new Promise((resolve) => fixture.server.close(resolve));
  await fs.rm(fixture.directory, { recursive: true, force: true });
  fixture = await createFixture({ production: true });
  const result = await api('/api/v1/vapid-public-key', {
    headers: { 'X-Forwarded-Proto': 'https' }
  });
  assert.equal(result.response.status, 426);
  assert.equal(result.body.error, 'HTTPS_REQUIRED');
});

test('producción acepta HTTPS informado por Nginx sólo desde proxy loopback confiable', async () => {
  await new Promise((resolve) => fixture.server.close(resolve));
  await fs.rm(fixture.directory, { recursive: true, force: true });
  fixture = await createFixture({ production: true, trustProxy: 'loopback' });
  const result = await api('/api/v1/vapid-public-key', {
    headers: { 'X-Forwarded-Proto': 'https' }
  });
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('strict-transport-security'), /max-age=/);
});

test('configuración indiscriminada de trust proxy es rechazada', () => {
  assert.throws(() => normalizeTrustProxy('1'), /must not trust/);
  assert.throws(() => normalizeTrustProxy('true'), /must not trust/);
  assert.throws(() => normalizeTrustProxy('*'), /must not trust/);
  assert.equal(normalizeTrustProxy('loopback'), 'loopback');
  assert.equal(normalizeTrustProxy('10.20.30.4/32'), '10.20.30.4/32');
});

test('producción sin claves VAPID falla sin crear fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nugon-vapid-test-'));
  try {
    assert.throws(
      () => loadVapidConfiguration({ environment: 'production', dataDir: directory, env: {} }),
      /VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required/);
    await assert.rejects(
      fs.access(path.join(directory, 'vapid-development.json')),
      (error) => error.code === 'ENOENT');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('fallback VAPID se crea sólo en desarrollo con modo 0600', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nugon-vapid-test-'));
  try {
    const vapid = loadVapidConfiguration({
      environment: 'development', dataDir: directory, env: {}
    });
    assert.ok(vapid.publicKey);
    assert.ok(vapid.privateKey);
    const file = path.join(directory, 'vapid-development.json');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.throws(
      () => loadVapidConfiguration({ environment: 'staging', dataDir: directory, env: {} }),
      /VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('producción exige RATE_LIMIT_SECRET independiente', () => {
  assert.throws(
    () => resolveRateLimitSecret({
      environment: 'production',
      env: {},
      developmentFallback: 'vapid-private-key-that-is-long-enough-for-tests'
    }),
    /RATE_LIMIT_SECRET is required when NODE_ENV=production/);
  assert.throws(
    () => resolveRateLimitSecret({
      environment: 'production',
      env: { RATE_LIMIT_SECRET: 'short' },
      developmentFallback: 'vapid-private-key-that-is-long-enough-for-tests'
    }),
    /at least 32 bytes/);
  assert.equal(resolveRateLimitSecret({
    environment: 'production',
    env: { RATE_LIMIT_SECRET: TEST_RATE_LIMIT_SECRET },
    developmentFallback: 'not-used'
  }), TEST_RATE_LIMIT_SECRET);
});

test('development puede usar fallback VAPID para rate limit', () => {
  const fallback = 'development-vapid-private-key-with-32-bytes';
  assert.equal(resolveRateLimitSecret({
    environment: 'development', env: {}, developmentFallback: fallback
  }), fallback);
});
