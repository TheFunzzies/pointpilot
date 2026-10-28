/**
 * PointPilot SimpleFIN Protocol Client
 *
 * Implements the official SimpleFIN protocol (v2.0.0-draft / v1 compatible)
 * Specification: https://www.simplefin.org/protocol.html
 *
 * Dependency-free: uses only Node.js built-in modules (node:net, node:util).
 */

import net from 'node:net';
import util from 'node:util';

// Constants
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_CLAIM_BYTES = 64 * 1024; // 64 KB
export const MAX_CURRENCY_BYTES = 32 * 1024; // 32 KB
export const DEFAULT_VERSION = 2;

const URL_CREDS_REGEX = /(https?:\/\/)([^:@\s"']+):([^@\s"']+)@/gi;
const BASIC_AUTH_REGEX = /Basic\s+[A-Za-z0-9+/=]+/gi;
const BEARER_AUTH_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

/**
 * Custom error class for SimpleFIN operations with automatic secret redaction.
 */
export class SimpleFinError extends Error {
  constructor(message, status = 400, code = 'SIMPLEFIN_ERROR') {
    super(redactSecrets(message));
    this.name = 'SimpleFinError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Custom error for authentication failures (e.g. 403 Forbidden).
 */
export class SimpleFinAuthError extends SimpleFinError {
  constructor(message, status = 403, code = 'SIMPLEFIN_AUTH_ERROR') {
    super(message, status, code);
    this.name = 'SimpleFinAuthError';
  }
}

/**
 * Redact sensitive tokens, passwords in URLs, and Authorization headers from text.
 */
export function redactSecrets(value) {
  if (typeof value !== 'string') {
    if (value && typeof value === 'object' && typeof value.message === 'string') {
      value.message = redactSecrets(value.message);
      return value;
    }
    return '';
  }
  return value
    .replace(URL_CREDS_REGEX, '$1$2:***@')
    .replace(BASIC_AUTH_REGEX, 'Basic [REDACTED]')
    .replace(BEARER_AUTH_REGEX, 'Bearer [REDACTED]');
}

/**
 * Masks the password in an access URL (e.g. https://user:pass@host -> https://user:***@host).
 */
export function maskAccessUrl(accessUrl) {
  if (typeof accessUrl !== 'string' || !accessUrl.trim()) return '[REDACTED]';
  try {
    const u = new URL(accessUrl.trim());
    if (u.username || u.password) {
      u.password = '***';
    }
    return u.toString();
  } catch {
    return '[REDACTED]';
  }
}

/**
 * Checks if a hostname belongs to localhost, a private network, or a reserved literal IP.
 */
export function isDisallowedHost(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') return true;
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return true;
  }

  const ipType = net.isIP(host);
  if (ipType === 4) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [b0, b1, b2] = parts;
    if (b0 === 0) return true; // 0.0.0.0/8
    if (b0 === 10) return true; // 10.0.0.0/8
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10 CGNAT
    if (b0 === 127) return true; // 127.0.0.0/8 Loopback
    if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 Link-local
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
    if (b0 === 192 && b1 === 0 && b2 === 0) return true; // 192.0.0.0/24
    if (b0 === 192 && b1 === 0 && b2 === 2) return true; // 192.0.2.0/24 Documentation
    if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true; // 198.18.0.0/15
    if (b0 === 198 && b1 === 51 && b2 === 100) return true; // 198.51.100.0/24 Documentation
    if (b0 === 203 && b1 === 0 && b2 === 113) return true; // 203.0.113.0/24 Documentation
    if (b0 >= 224) return true; // Multicast & Reserved
    return false;
  }

  if (ipType === 6) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // Unique local
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true; // Link-local
    if (host.startsWith('2001:db8')) return true; // Documentation
    if (host.includes('::ffff:')) {
      const v4 = host.slice(host.lastIndexOf(':') + 1);
      if (net.isIP(v4) === 4) return isDisallowedHost(v4);
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Validates a claim URL per SimpleFIN security requirements.
 */
export function validateClaimUrl(urlInput) {
  if (typeof urlInput !== 'string' || !urlInput.trim()) {
    throw new SimpleFinError('Claim URL must be a non-empty string', 400, 'INVALID_CLAIM_URL');
  }

  const trimmed = urlInput.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SimpleFinError('Claim URL is not a valid URL', 400, 'INVALID_CLAIM_URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new SimpleFinError('Claim URL must use HTTPS', 400, 'NON_HTTPS_URL');
  }

  if (parsed.username || parsed.password) {
    throw new SimpleFinError('Claim URL must not contain credentials', 400, 'URL_CREDENTIALS_DISALLOWED');
  }

  if (isDisallowedHost(parsed.hostname)) {
    throw new SimpleFinError('Claim URL host is not permitted (localhost or private network)', 400, 'DISALLOWED_HOST');
  }

  return parsed.toString();
}

/**
 * Decodes and validates a base64-encoded SimpleFIN claim token.
 * Returns the decoded claim URL string.
 */
export function decodeClaimToken(token) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new SimpleFinError('SimpleFIN claim token must be a non-empty string', 400, 'INVALID_CLAIM_TOKEN');
  }

  const cleaned = token.trim();
  let b64 = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new SimpleFinError('SimpleFIN claim token is not valid base64', 400, 'INVALID_CLAIM_TOKEN');
  }

  let decoded;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    throw new SimpleFinError('Failed to decode SimpleFIN claim token', 400, 'INVALID_CLAIM_TOKEN');
  }

  // eslint-disable-next-line no-control-regex
  if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new SimpleFinError('Claim token contains invalid characters', 400, 'INVALID_CLAIM_TOKEN');
  }

  return validateClaimUrl(decoded);
}

/**
 * Validates a claim token and returns a descriptor.
 */
export function validateClaimToken(token) {
  const claimUrl = decodeClaimToken(token);
  return { valid: true, claimUrl };
}

/**
 * Encapsulates a validated SimpleFIN Access URL, concealing credentials from default inspection.
 */
export class SimpleFinAccess {
  #accessUrl;
  #password;

  constructor(accessUrl) {
    if (typeof accessUrl !== 'string' || !accessUrl.trim()) {
      throw new SimpleFinError('Access URL must be a non-empty string', 400, 'INVALID_ACCESS_URL');
    }

    const trimmed = accessUrl.trim();
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new SimpleFinError('Access URL is not a valid URL', 400, 'INVALID_ACCESS_URL');
    }

    if (parsed.protocol !== 'https:') {
      throw new SimpleFinError('Access URL must use HTTPS', 400, 'NON_HTTPS_URL');
    }

    if (!parsed.username || !parsed.password) {
      throw new SimpleFinError('Access URL is missing required credentials', 400, 'MISSING_CREDENTIALS');
    }

    if (isDisallowedHost(parsed.hostname)) {
      throw new SimpleFinError('Access URL host is not permitted (localhost or private network)', 400, 'DISALLOWED_HOST');
    }

    this.#accessUrl = trimmed;
    this.username = decodeURIComponent(parsed.username);
    this.#password = decodeURIComponent(parsed.password);

    const clean = new URL(trimmed);
    clean.username = '';
    clean.password = '';
    this.baseUrl = clean.origin + clean.pathname.replace(/\/+$/, '');
    this.accountsUrl = `${this.baseUrl}/accounts`;
    this.maskedUrl = maskAccessUrl(trimmed);
    this.authHeader = 'Basic ' + Buffer.from(`${this.username}:${this.#password}`).toString('base64');
  }

  get accessUrl() {
    return this.#accessUrl;
  }

  get password() {
    return this.#password;
  }

  toJSON() {
    return {
      baseUrl: this.baseUrl,
      accountsUrl: this.accountsUrl,
      username: this.username,
      maskedUrl: this.maskedUrl,
    };
  }

  [util.inspect.custom]() {
    return {
      baseUrl: this.baseUrl,
      accountsUrl: this.accountsUrl,
      username: this.username,
      maskedUrl: this.maskedUrl,
    };
  }

  toString() {
    return this.#accessUrl;
  }
}

/**
 * Validates and safely retains an access URL.
 */
export function validateAccessUrl(accessUrlInput) {
  if (accessUrlInput instanceof SimpleFinAccess) return accessUrlInput;
  if (accessUrlInput && typeof accessUrlInput === 'object' && typeof accessUrlInput.accessUrl === 'string') {
    return new SimpleFinAccess(accessUrlInput.accessUrl);
  }
  return new SimpleFinAccess(accessUrlInput);
}

/**
 * Internal safe fetch with bounded response size, timeout, and redirect prohibition.
 */
async function safeFetch(url, options = {}) {
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new SimpleFinError('Fetch implementation is not available', 500, 'FETCH_UNAVAILABLE');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let onAbort;
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw options.signal.reason || new Error('Request aborted');
    }
    onAbort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const fetchOptions = {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
    };
    delete fetchOptions.fetch;
    delete fetchOptions.timeoutMs;
    delete fetchOptions.maxBytes;

    let res;
    try {
      res = await fetchFn(url, fetchOptions);
    } catch (err) {
      if (timedOut) {
        throw new SimpleFinError(`Request timed out after ${timeoutMs}ms`, 408, 'TIMEOUT');
      }
      throw new SimpleFinError(`Network error: ${redactSecrets(err.message)}`, 502, 'NETWORK_ERROR');
    }

    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      throw new SimpleFinError(`Redirect (HTTP ${res.status}) is not permitted by SimpleFIN protocol`, res.status, 'REDIRECT_DISALLOWED');
    }

    // Check Content-Length header if present
    const contentLength = res.headers?.get?.('content-length');
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        throw new SimpleFinError(`Response size (${parsedLength} bytes) exceeds maximum limit of ${maxBytes} bytes`, 413, 'MAX_SIZE_EXCEEDED');
      }
    }

    let bodyText = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new SimpleFinError(`Response exceeded maximum allowed size of ${maxBytes} bytes`, 413, 'MAX_SIZE_EXCEEDED');
          }
          chunks.push(value);
        }
      } catch (readErr) {
        if (readErr instanceof SimpleFinError) throw readErr;
        throw new SimpleFinError(`Error reading response: ${redactSecrets(readErr.message)}`, 502, 'READ_ERROR');
      }
      bodyText = Buffer.concat(chunks).toString('utf8');
    } else if (typeof res.text === 'function') {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new SimpleFinError(`Response exceeded maximum allowed size of ${maxBytes} bytes`, 413, 'MAX_SIZE_EXCEEDED');
      }
      bodyText = text;
    }

    return { response: res, text: bodyText };
  } finally {
    clearTimeout(timer);
    if (options.signal && onAbort) {
      options.signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Claims an access URL by POSTing to the one-time claim URL or token.
 */
export async function claimAccessUrl(claimUrlOrToken, options = {}) {
  let claimUrl;
  if (typeof claimUrlOrToken === 'string') {
    const trimmed = claimUrlOrToken.trim();
    if (trimmed.startsWith('https://')) {
      claimUrl = validateClaimUrl(trimmed);
    } else {
      claimUrl = decodeClaimToken(trimmed);
    }
  } else {
    throw new SimpleFinError('Claim token or URL must be a non-empty string', 400, 'INVALID_INPUT');
  }

  const { response, text } = await safeFetch(claimUrl, {
    method: 'POST',
    headers: {
      Accept: 'text/plain, */*',
    },
    fetch: options.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? MAX_CLAIM_BYTES,
    signal: options.signal,
  });

  if (response.status === 403) {
    throw new SimpleFinAuthError(
      'SimpleFIN claim token rejected (403 Forbidden). The token may have already been claimed, expired, or compromised. Please generate a new token.',
      403,
      'CLAIM_FORBIDDEN'
    );
  }

  if (!response.ok) {
    throw new SimpleFinError(
      `SimpleFIN claim failed with HTTP status ${response.status}`,
      response.status,
      'CLAIM_FAILED'
    );
  }

  const rawAccessUrl = text.trim();
  if (!rawAccessUrl) {
    throw new SimpleFinError('SimpleFIN claim returned an empty response', 502, 'EMPTY_CLAIM_RESPONSE');
  }

  return validateAccessUrl(rawAccessUrl);
}

/**
 * Fetches accounts from a SimpleFIN server using balances-only=1 and version=2 by default.
 */
export async function fetchAccounts(accessUrlInput, options = {}) {
  const access = validateAccessUrl(accessUrlInput);

  const url = new URL(access.accountsUrl);
  const balancesOnly = options.balancesOnly !== false;
  if (balancesOnly) {
    url.searchParams.set('balances-only', '1');
  }
  const version = options.version ?? DEFAULT_VERSION;
  url.searchParams.set('version', String(version));

  if (options.startDate != null) {
    url.searchParams.set('start-date', String(options.startDate));
  }
  if (options.endDate != null) {
    url.searchParams.set('end-date', String(options.endDate));
  }
  if (options.pending) {
    url.searchParams.set('pending', '1');
  }
  if (options.account) {
    if (Array.isArray(options.account)) {
      for (const id of options.account) {
        url.searchParams.append('account', String(id));
      }
    } else {
      url.searchParams.set('account', String(options.account));
    }
  }

  const { response, text } = await safeFetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: access.authHeader,
      Accept: 'application/json',
    },
    fetch: options.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    signal: options.signal,
  });

  if (response.status === 403) {
    throw new SimpleFinAuthError(
      'SimpleFIN access revoked or credentials invalid (403 Forbidden).',
      403,
      'ACCESS_REVOKED'
    );
  }

  if (response.status === 402) {
    throw new SimpleFinError(
      'SimpleFIN subscription payment required (402 Payment Required).',
      402,
      'PAYMENT_REQUIRED'
    );
  }

  if (!response.ok) {
    throw new SimpleFinError(
      `SimpleFIN accounts request failed with HTTP ${response.status}`,
      response.status,
      'FETCH_ACCOUNTS_FAILED'
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SimpleFinError(
      `Failed to parse SimpleFIN accounts JSON: ${redactSecrets(err.message)}`,
      502,
      'INVALID_JSON'
    );
  }

  if (!data || typeof data !== 'object') {
    throw new SimpleFinError('SimpleFIN response is not a valid JSON object', 502, 'INVALID_RESPONSE');
  }

  const errors = normalizeErrlist(data);

  const connectionMap = new Map();
  const normalizedConnections = [];
  if (Array.isArray(data.connections)) {
    for (const c of data.connections) {
      if (c && typeof c === 'object') {
        const id = c.conn_id || c.connId || '';
        const conn = {
          connId: String(id),
          name: sanitizeText(c.name || '', 120),
          orgId: c.org_id ? String(c.org_id) : null,
          orgName: c.org_name ? sanitizeText(String(c.org_name), 120) : null,
          orgUrl: c.org_url ? sanitizeText(String(c.org_url), 240) : null,
          sfinUrl: c.sfin_url ? sanitizeText(String(c.sfin_url), 240) : null,
        };
        if (id) connectionMap.set(id, conn);
        normalizedConnections.push(conn);
      }
    }
  }

  // Resolve custom currencies if present
  const customCurrencies = new Map();
  if (options.resolveCustomCurrencies !== false && Array.isArray(data.accounts)) {
    const customUrls = new Set();
    for (const a of data.accounts) {
      if (typeof a?.currency === 'string' && /^https:\/\//i.test(a.currency)) {
        customUrls.add(a.currency);
      }
    }
    for (const curUrl of customUrls) {
      try {
        const meta = await fetchCustomCurrency(curUrl, {
          fetch: options.fetch,
          timeoutMs: options.currencyTimeoutMs ?? 5000,
        });
        customCurrencies.set(curUrl, meta);
      } catch {
        customCurrencies.set(curUrl, {
          type: 'custom',
          name: 'Custom Currency',
          abbr: 'custom',
          url: curUrl,
          valid: false,
        });
      }
    }
  }

  const normalizedAccounts = normalizeAccounts(data.accounts || [], {
    connectionMap,
    customCurrencies,
    balancesOnly,
  });

  return {
    accounts: normalizedAccounts,
    connections: normalizedConnections,
    errors,
    errlist: errors,
    balancesOnly,
    version,
  };
}

export const fetchSimpleFinAccounts = fetchAccounts;

/**
 * Normalizes structured errlist and legacy error strings from an AccountSet.
 */
export function normalizeErrlist(data) {
  const out = [];
  if (Array.isArray(data?.errlist)) {
    for (const e of data.errlist) {
      if (!e || typeof e !== 'object') continue;
      const code = typeof e.code === 'string' ? e.code.trim() : 'gen.unknown';
      const parts = code.split('.');
      const prefix = parts[0] || 'gen';
      const subcode = parts.slice(1).join('.') || null;
      out.push({
        code,
        prefix,
        subcode,
        msg: redactSecrets(sanitizeText(e.msg || 'Unknown error', 240)),
        connId: e.conn_id ? String(e.conn_id) : null,
        accountId: e.account_id ? String(e.account_id) : null,
      });
    }
  }

  if (out.length === 0 && Array.isArray(data?.errors)) {
    for (const msg of data.errors) {
      if (typeof msg === 'string' && msg.trim()) {
        out.push({
          code: 'gen.legacy',
          prefix: 'gen',
          subcode: 'legacy',
          msg: redactSecrets(sanitizeText(msg, 240)),
          connId: null,
          accountId: null,
        });
      }
    }
  }
  return out;
}

/**
 * Fetches custom currency metadata from an HTTPS URL and sanitizes the output.
 */
export async function fetchCustomCurrency(currencyUrl, options = {}) {
  if (typeof currencyUrl !== 'string' || !currencyUrl.trim()) {
    throw new SimpleFinError('Custom currency URL must be a non-empty string', 400, 'INVALID_CURRENCY_URL');
  }

  const cleanUrl = currencyUrl.trim();
  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    throw new SimpleFinError('Custom currency URL is not a valid URL', 400, 'INVALID_CURRENCY_URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new SimpleFinError('Custom currency URL must use HTTPS', 400, 'NON_HTTPS_URL');
  }

  if (parsed.username || parsed.password) {
    throw new SimpleFinError('Custom currency URL must not contain credentials', 400, 'URL_CREDENTIALS_DISALLOWED');
  }

  if (isDisallowedHost(parsed.hostname)) {
    throw new SimpleFinError('Custom currency URL host is not permitted', 400, 'DISALLOWED_HOST');
  }

  const { response, text } = await safeFetch(cleanUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    fetch: options.fetch,
    timeoutMs: options.timeoutMs ?? 5000,
    maxBytes: options.maxBytes ?? MAX_CURRENCY_BYTES,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new SimpleFinError(
      `Custom currency request failed with HTTP ${response.status}`,
      response.status,
      'CURRENCY_FETCH_FAILED'
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new SimpleFinError(
      `Failed to parse custom currency JSON: ${redactSecrets(err.message)}`,
      502,
      'INVALID_JSON'
    );
  }

  return sanitizeCurrencyMeta({
    name: json?.name,
    abbr: json?.abbr,
    url: cleanUrl,
  });
}

/**
 * Sanitizes and structures currency metadata.
 */
export function sanitizeCurrencyMeta({ name, abbr, url = null }) {
  const sanitizedName = sanitizeText(name || '', 64) || 'Custom Currency';
  const sanitizedAbbr = sanitizeText(abbr || '', 16) || 'custom';
  return {
    type: 'custom',
    name: sanitizedName,
    abbr: sanitizedAbbr,
    url: url ? String(url) : null,
    valid: true,
  };
}

/**
 * Normalizes a single account record.
 */
export function normalizeAccount(rawAccount, options = {}) {
  if (!rawAccount || typeof rawAccount !== 'object') {
    throw new SimpleFinError('Account record must be an object', 400, 'INVALID_ACCOUNT_RECORD');
  }

  const id = String(rawAccount.id ?? '');
  if (!id) {
    throw new SimpleFinError('Account record is missing required "id"', 400, 'MISSING_ACCOUNT_ID');
  }

  const name = sanitizeText(rawAccount.name || 'Unnamed Account', 120);
  const connId = rawAccount.conn_id || rawAccount.connId ? String(rawAccount.conn_id || rawAccount.connId) : null;
  const connection = connId && options.connectionMap?.get ? options.connectionMap.get(connId) : null;
  const connectionName = connection?.name || (rawAccount.conn_name ? sanitizeText(String(rawAccount.conn_name), 120) : null);

  const rawCurrency = typeof rawAccount.currency === 'string' ? rawAccount.currency.trim() : 'USD';
  const isCustomCurrency = /^https:\/\//i.test(rawCurrency);

  let currencyMeta;
  if (isCustomCurrency) {
    const existing = options.customCurrencies?.get?.(rawCurrency);
    if (existing) {
      currencyMeta = {
        type: 'custom',
        code: null,
        name: existing.name,
        abbr: existing.abbr,
        url: rawCurrency,
      };
    } else {
      currencyMeta = {
        type: 'custom',
        code: null,
        name: 'Custom Currency',
        abbr: 'pts',
        url: rawCurrency,
      };
    }
  } else {
    const code = sanitizeText(rawCurrency.toUpperCase(), 12) || 'USD';
    currencyMeta = {
      type: 'standard',
      code,
      name: code,
      abbr: code,
      url: null,
    };
  }

  const balanceRaw = rawAccount.balance != null ? String(rawAccount.balance).trim() : '0';
  const balanceNum = Number(balanceRaw);
  const balance = Number.isFinite(balanceNum) ? balanceNum : 0;

  const availRaw = rawAccount['available-balance'] != null ? String(rawAccount['available-balance']).trim() : null;
  let availableBalance;
  let availableBalanceString;
  if (availRaw != null) {
    const availNum = Number(availRaw);
    availableBalance = Number.isFinite(availNum) ? availNum : balance;
    availableBalanceString = availRaw;
  } else {
    availableBalance = balance;
    availableBalanceString = balanceRaw;
  }

  const balanceTimestamp = Number.isFinite(Number(rawAccount['balance-date']))
    ? Math.floor(Number(rawAccount['balance-date']))
    : null;
  const balanceDate = balanceTimestamp != null
    ? new Date(balanceTimestamp * 1000).toISOString()
    : new Date().toISOString();

  const transactions = Array.isArray(rawAccount.transactions) ? rawAccount.transactions : [];

  return {
    id,
    name,
    connectionId: connId,
    connectionName,
    currency: rawCurrency,
    isCustomCurrency,
    currencyMeta,
    balance,
    balanceString: balanceRaw,
    availableBalance,
    availableBalanceString,
    balanceTimestamp,
    balanceDate,
    transactions,
    balancesOnly: options.balancesOnly !== false || transactions.length === 0,
    extra: rawAccount.extra && typeof rawAccount.extra === 'object' ? rawAccount.extra : null,
  };
}

/**
 * Normalizes an array of account records.
 */
export function normalizeAccounts(rawAccounts, options = {}) {
  if (!Array.isArray(rawAccounts)) return [];
  return rawAccounts.map(a => normalizeAccount(a, options));
}

/**
 * Normalizes a full SimpleFIN AccountSet payload.
 */
export function normalizeAccountSet(data, options = {}) {
  const errors = normalizeErrlist(data);
  const connectionMap = new Map();
  const connections = [];
  if (Array.isArray(data?.connections)) {
    for (const c of data.connections) {
      if (c && typeof c === 'object') {
        const id = c.conn_id || c.connId || '';
        const conn = {
          connId: String(id),
          name: sanitizeText(c.name || '', 120),
          orgId: c.org_id ? String(c.org_id) : null,
          orgName: c.org_name ? sanitizeText(String(c.org_name), 120) : null,
          orgUrl: c.org_url ? sanitizeText(String(c.org_url), 240) : null,
          sfinUrl: c.sfin_url ? sanitizeText(String(c.sfin_url), 240) : null,
        };
        if (id) connectionMap.set(id, conn);
        connections.push(conn);
      }
    }
  }

  const accounts = normalizeAccounts(data?.accounts || [], {
    ...options,
    connectionMap,
  });

  return {
    accounts,
    connections,
    errors,
    errlist: errors,
    balancesOnly: options.balancesOnly !== false,
  };
}

/**
 * Sanitize untrusted user-facing strings (removes scripts/styles, HTML tags, control characters, collapses spaces).
 */
export function sanitizeText(value, maxLength = 240) {
  if (typeof value !== 'string') {
    if (value == null) return '';
    value = String(value);
  }
  return value
    .normalize('NFKC')
    // Remove script, style, and iframe tags with their enclosed contents
    .replace(/<(script|style|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Remove remaining HTML tags
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * High-level stateful SimpleFIN Client.
 */
export class SimpleFinClient {
  constructor(accessUrlInput, options = {}) {
    this.access = validateAccessUrl(accessUrlInput);
    this.options = { ...options };
  }

  static async claim(claimUrlOrToken, options = {}) {
    const access = await claimAccessUrl(claimUrlOrToken, options);
    return new SimpleFinClient(access, options);
  }

  get accessUrl() {
    return this.access.accessUrl;
  }

  get maskedUrl() {
    return this.access.maskedUrl;
  }

  get baseUrl() {
    return this.access.baseUrl;
  }

  get accountsUrl() {
    return this.access.accountsUrl;
  }

  async fetchAccounts(options = {}) {
    return fetchAccounts(this.access, {
      ...this.options,
      ...options,
    });
  }

  toJSON() {
    return {
      baseUrl: this.baseUrl,
      accountsUrl: this.accountsUrl,
      maskedUrl: this.maskedUrl,
      username: this.access.username,
    };
  }

  [util.inspect.custom]() {
    return {
      baseUrl: this.baseUrl,
      accountsUrl: this.accountsUrl,
      maskedUrl: this.maskedUrl,
      username: this.access.username,
    };
  }
}
