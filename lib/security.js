const crypto = require('crypto');

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const PAIRING_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(value, secret) {
  return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

function safeHashEquals(value, expectedHash) {
  const actual = Buffer.from(sha256(value), 'hex');
  const expected = Buffer.from(
    typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash)
      ? expectedHash
      : '0'.repeat(64),
    'hex'
  );
  return crypto.timingSafeEqual(actual, expected);
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomPairingCode() {
  const bytes = crypto.randomBytes(12);
  let raw = '';
  for (const byte of bytes) raw += CROCKFORD[byte & 31];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

function normalizePairingCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';
}

function isValidDeviceId(value) {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length >= 16;
  } catch {
    return false;
  }
}

function isValidSecret(value) {
  if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length >= 32;
  } catch {
    return false;
  }
}

function isValidPairingCode(value) {
  return PAIRING_PATTERN.test(normalizePairingCode(value));
}

function bearerToken(request) {
  const header = request.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

module.exports = {
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
};
