// Encrypted backup envelope: scrypt + AES-256-GCM using only node:crypto.
// The envelope header is authenticated (GCM AAD), the KDF parameters are fixed so an imported file can
// never request arbitrary work, and nothing is parsed or staged until the ciphertext has authenticated.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const BACKUP_FORMAT = 'pointpilot-backup';
export const BACKUP_VERSION = 1;
export const KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1 });
export const SALT_BYTES = 16, IV_BYTES = 12, TAG_BYTES = 16, KEY_BYTES = 32;
export const MIN_PASSWORD_CHARS = 12, MAX_PASSWORD_BYTES = 1024;
export const MAX_PLAINTEXT_BYTES = 12 * 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 18 * 1024 * 1024;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export class BackupError extends ApiError {}
const fail = (message, status, code) => new BackupError(message, status, code);
export const backupInvalid = (message = 'This file is not a valid PointPilot backup.') => fail(message, 400, 'BACKUP_INVALID');
const decryptFailed = () => fail('The password is wrong or the backup file was modified.', 400, 'BACKUP_DECRYPT_FAILED');

// One crypto operation at a time: scrypt allocates 128 MiB. A second concurrent job is refused, not queued.
let cryptoBusy = false;
export async function runCryptoJob(fn) {
  if (cryptoBusy) throw fail('Another backup operation is still running. Try again in a moment.', 429, 'BACKUP_BUSY');
  cryptoBusy = true;
  try { return await fn(); } finally { cryptoBusy = false; }
}

/** Normalize (NFKC) and validate a password; returns a Buffer the caller should zero when done. */
export function passwordBuffer(password, { enforceMinimum = true } = {}) {
  if (typeof password !== 'string') throw fail('Enter a password.', 400, 'PASSWORD_INVALID');
  const normalized = password.normalize('NFKC');
  if (enforceMinimum && [...normalized].length < MIN_PASSWORD_CHARS) throw fail(`Use a password of at least ${MIN_PASSWORD_CHARS} characters.`, 400, 'PASSWORD_INVALID');
  const buf = Buffer.from(normalized, 'utf8');
  if (buf.length > MAX_PASSWORD_BYTES) { buf.fill(0); throw fail(`The password is too long (limit ${MAX_PASSWORD_BYTES} bytes).`, 400, 'PASSWORD_INVALID'); }
  return buf;
}

function deriveKey(passwordBuf, salt) {
  return new Promise((resolve, reject) => {
    scrypt(passwordBuf, salt, KEY_BYTES, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Canonical bytes of the authenticated header: format, version, kdf and cipher name+iv (not tag/ciphertext). */
export function headerAad({ format, version, kdf, cipher }) {
  return Buffer.from(JSON.stringify({
    format, version,
    kdf: { name: kdf.name, N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
    cipher: { name: cipher.name, iv: cipher.iv }
  }), 'utf8');
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const hasExactKeys = (obj, keys) => isPlain(obj) && Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k));

function strictBase64(value, { exactBytes, maxBytes, minBytes = 1 }) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw backupInvalid();
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value) throw backupInvalid(); // rejects non-canonical padding / trailing bits
  if (exactBytes != null ? buf.length !== exactBytes : buf.length < minBytes || buf.length > maxBytes) throw backupInvalid();
  return buf;
}

/** Validate the whole envelope before any key derivation. Returns decoded buffers. */
export function validateEnvelope(envelope) {
  if (!isPlain(envelope)) throw backupInvalid();
  if (envelope.format !== BACKUP_FORMAT) throw backupInvalid();
  if (!Number.isInteger(envelope.version) || envelope.version < 1) throw backupInvalid();
  if (envelope.version !== BACKUP_VERSION) throw fail('This backup was made by a different version of PointPilot and cannot be read.', 400, 'BACKUP_UNSUPPORTED_VERSION');
  if (!hasExactKeys(envelope, ['format', 'version', 'kdf', 'cipher', 'ciphertext'])) throw backupInvalid();
  const { kdf, cipher } = envelope;
  if (!hasExactKeys(kdf, ['name', 'N', 'r', 'p', 'salt']) || kdf.name !== KDF.name || kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p) throw backupInvalid();
  if (!hasExactKeys(cipher, ['name', 'iv', 'tag']) || cipher.name !== 'aes-256-gcm') throw backupInvalid();
  return {
    salt: strictBase64(kdf.salt, { exactBytes: SALT_BYTES }),
    iv: strictBase64(cipher.iv, { exactBytes: IV_BYTES }),
    tag: strictBase64(cipher.tag, { exactBytes: TAG_BYTES }),
    ciphertext: strictBase64(envelope.ciphertext, { maxBytes: MAX_PLAINTEXT_BYTES })
  };
}

/** Encrypt a payload object. Fresh random salt and IV every time. */
export function encryptBackup(payload, password) {
  return runCryptoJob(async () => {
    const pw = passwordBuffer(password);
    let plaintext, key;
    try {
      plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
      if (plaintext.length > MAX_PLAINTEXT_BYTES) throw fail('This backup is too large to export.', 413, 'BACKUP_TOO_LARGE');
      const salt = randomBytes(SALT_BYTES), iv = randomBytes(IV_BYTES);
      key = await deriveKey(pw, salt);
      const header = { format: BACKUP_FORMAT, version: BACKUP_VERSION, kdf: { ...KDF, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') } };
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(headerAad(header));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = { format: header.format, version: header.version, kdf: header.kdf, cipher: { ...header.cipher, tag: cipher.getAuthTag().toString('base64') }, ciphertext: ciphertext.toString('base64') };
      if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_ENVELOPE_BYTES) throw fail('This backup is too large to export.', 413, 'BACKUP_TOO_LARGE');
      return envelope;
    } finally {
      pw.fill(0); plaintext?.fill(0); key?.fill(0);
    }
  });
}

/** Decrypt and parse. Wrong password and tampering are indistinguishable by design. */
export async function decryptBackup(envelope, password) {
  const parts = validateEnvelope(envelope);
  return runCryptoJob(async () => {
    const pw = passwordBuffer(password, { enforceMinimum: false });
    let key, plaintext;
    try {
      key = await deriveKey(pw, parts.salt);
      const decipher = createDecipheriv('aes-256-gcm', key, parts.iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(headerAad(envelope));
      decipher.setAuthTag(parts.tag);
      try { plaintext = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]); }
      catch { throw decryptFailed(); }
      try { return JSON.parse(plaintext.toString('utf8')); }
      catch { throw backupInvalid(); }
    } finally {
      pw.fill(0); key?.fill(0); plaintext?.fill(0);
    }
  });
}
