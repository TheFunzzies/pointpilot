import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import {
  decodeClaimToken,
  validateClaimToken,
  validateClaimUrl,
  claimAccessUrl,
  validateAccessUrl,
  maskAccessUrl,
  fetchAccounts,
  fetchCustomCurrency,
  normalizeAccount,
  normalizeErrlist,
  redactSecrets,
  isDisallowedHost,
  SimpleFinAccess,
  SimpleFinClient,
  SimpleFinError,
} from '../lib/simplefin-protocol.mjs';

// --- Test Data & Helpers ---

const VALID_CLAIM_URL = 'https://bridge.simplefin.org/simplefin/claim/demo';
const VALID_TOKEN = Buffer.from(VALID_CLAIM_URL).toString('base64');
const VALID_ACCESS_URL = 'https://demo_user:super_secret_pass_456@bridge.simplefin.org/simplefin';

function mockResponse(body, { status = 200, headers = {}, type = 'basic' } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const textBody = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    type,
    headers: {
      get: key => headerMap.get(key.toLowerCase()) || null,
    },
    text: async () => textBody,
    body: {
      getReader: () => {
        let read = false;
        return {
          read: async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: Buffer.from(textBody, 'utf8') };
          },
          cancel: async () => {},
        };
      },
    },
  };
}

// ==========================================
// 1. Claim Token Decoding & URL Validation
// ==========================================

test('decodeClaimToken successfully decodes valid base64 and url-safe base64 tokens', () => {
  const decoded = decodeClaimToken(VALID_TOKEN);
  assert.equal(decoded, VALID_CLAIM_URL);

  const descriptor = validateClaimToken(VALID_TOKEN);
  assert.equal(descriptor.valid, true);
  assert.equal(descriptor.claimUrl, VALID_CLAIM_URL);

  // URL-safe base64 without padding
  const urlSafe = Buffer.from('https://bridge.simplefin.org/simplefin/claim/test-abc_123').toString('base64url');
  assert.equal(decodeClaimToken(urlSafe), 'https://bridge.simplefin.org/simplefin/claim/test-abc_123');

  // Token with surrounding whitespace
  assert.equal(decodeClaimToken(`  \n${VALID_TOKEN}\r\n  `), VALID_CLAIM_URL);
});

test('decodeClaimToken rejects malformed or non-base64 tokens', () => {
  assert.throws(() => decodeClaimToken(''), {
    name: 'SimpleFinError',
    code: 'INVALID_CLAIM_TOKEN',
  });
  assert.throws(() => decodeClaimToken(null), {
    name: 'SimpleFinError',
    code: 'INVALID_CLAIM_TOKEN',
  });
  assert.throws(() => decodeClaimToken('NotValidBase64!@#$%^'), {
    name: 'SimpleFinError',
    code: 'INVALID_CLAIM_TOKEN',
  });
  // Valid base64 but contains control characters
  const badContentToken = Buffer.from('https://bridge.simplefin.org/\x00/claim').toString('base64');
  assert.throws(() => decodeClaimToken(badContentToken), {
    name: 'SimpleFinError',
    code: 'INVALID_CLAIM_TOKEN',
  });
});

test('validateClaimUrl enforces HTTPS only', () => {
  assert.throws(() => validateClaimUrl('http://bridge.simplefin.org/claim'), {
    name: 'SimpleFinError',
    code: 'NON_HTTPS_URL',
  });
  assert.throws(() => validateClaimUrl('ftp://bridge.simplefin.org/claim'), {
    name: 'SimpleFinError',
    code: 'NON_HTTPS_URL',
  });
  assert.throws(() => validateClaimUrl('javascript:alert(1)'), {
    name: 'SimpleFinError',
    code: 'NON_HTTPS_URL',
  });

  // Base64 containing HTTP
  const httpToken = Buffer.from('http://bridge.simplefin.org/simplefin/claim/demo').toString('base64');
  assert.throws(() => decodeClaimToken(httpToken), {
    name: 'SimpleFinError',
    code: 'NON_HTTPS_URL',
  });
});

test('validateClaimUrl rejects credentials in claim URL', () => {
  assert.throws(() => validateClaimUrl('https://admin:pass@bridge.simplefin.org/claim'), {
    name: 'SimpleFinError',
    code: 'URL_CREDENTIALS_DISALLOWED',
  });

  const credToken = Buffer.from('https://admin:pass@bridge.simplefin.org/claim').toString('base64');
  assert.throws(() => decodeClaimToken(credToken), {
    name: 'SimpleFinError',
    code: 'URL_CREDENTIALS_DISALLOWED',
  });
});

test('isDisallowedHost and validateClaimUrl reject localhost and private networks', () => {
  const disallowed = [
    'https://localhost/claim',
    'https://localhost.localdomain/claim',
    'https://bank.local/claim',
    'https://service.internal/claim',
    'https://intranet.lan/claim',
    'https://sub.localhost/claim',
    'https://127.0.0.1/claim',
    'https://127.0.1.1/claim',
    'https://10.0.0.1/claim',
    'https://10.255.255.255/claim',
    'https://172.16.0.1/claim',
    'https://172.31.255.254/claim',
    'https://192.168.1.1/claim',
    'https://169.254.169.254/claim',
    'https://100.64.0.1/claim',
    'https://0.0.0.0/claim',
    'https://[::1]/claim',
    'https://[fc00::1]/claim',
    'https://[fd12:3456:789a::1]/claim',
    'https://[fe80::1]/claim',
    'https://[::ffff:127.0.0.1]/claim',
  ];

  for (const url of disallowed) {
    assert.throws(
      () => validateClaimUrl(url),
      { name: 'SimpleFinError', code: 'DISALLOWED_HOST' },
      `Expected ${url} to be rejected as disallowed host`
    );
  }

  // Allowed public hosts
  assert.equal(isDisallowedHost('bridge.simplefin.org'), false);
  assert.equal(isDisallowedHost('simplefin.mybank.com'), false);
  assert.equal(isDisallowedHost('8.8.8.8'), false);
});

// ==========================================
// 2. POSTing Claim URL & Access URL Handling
// ==========================================

test('claimAccessUrl POSTs claim URL and returns validated SimpleFinAccess', async () => {
  let capturedUrl = null;
  let capturedMethod = null;
  let capturedHeaders = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedMethod = options.method;
    capturedHeaders = options.headers;
    return mockResponse(`${VALID_ACCESS_URL}\n`);
  };

  const access = await claimAccessUrl(VALID_TOKEN, { fetch: mockFetch });

  assert.equal(capturedUrl, VALID_CLAIM_URL);
  assert.equal(capturedMethod, 'POST');
  assert.equal(capturedHeaders.Accept, 'text/plain, */*');

  assert.equal(access.accessUrl, VALID_ACCESS_URL);
  assert.equal(access.username, 'demo_user');
  assert.equal(access.password, 'super_secret_pass_456');
  assert.equal(access.baseUrl, 'https://bridge.simplefin.org/simplefin');
  assert.equal(access.accountsUrl, 'https://bridge.simplefin.org/simplefin/accounts');
  assert.equal(access.maskedUrl, 'https://demo_user:***@bridge.simplefin.org/simplefin');
  assert.equal(access.authHeader, 'Basic ' + Buffer.from('demo_user:super_secret_pass_456').toString('base64'));

  // toString returns accessUrl string
  assert.equal(String(access), VALID_ACCESS_URL);
});

test('claimAccessUrl handles 403 with descriptive compromise notification', async () => {
  const mockFetch = async () => mockResponse('Forbidden', { status: 403 });

  await assert.rejects(
    () => claimAccessUrl(VALID_TOKEN, { fetch: mockFetch }),
    err => {
      assert.equal(err.name, 'SimpleFinAuthError');
      assert.equal(err.status, 403);
      assert.equal(err.code, 'CLAIM_FORBIDDEN');
      assert.match(err.message, /compromised|expired|claimed/i);
      return true;
    }
  );
});

test('claimAccessUrl rejects redirects without following them', async () => {
  const mockFetch = async () =>
    mockResponse('', {
      status: 302,
      headers: { Location: 'https://attacker.example/steal' },
    });

  await assert.rejects(
    () => claimAccessUrl(VALID_TOKEN, { fetch: mockFetch }),
    err => {
      assert.equal(err.name, 'SimpleFinError');
      assert.equal(err.status, 302);
      assert.equal(err.code, 'REDIRECT_DISALLOWED');
      return true;
    }
  );
});

test('validateAccessUrl validates scheme, credentials, and host', () => {
  // Missing credentials
  assert.throws(() => validateAccessUrl('https://bridge.simplefin.org/simplefin'), {
    name: 'SimpleFinError',
    code: 'MISSING_CREDENTIALS',
  });

  // Non-HTTPS
  assert.throws(() => validateAccessUrl('http://demo:pass@bridge.simplefin.org/simplefin'), {
    name: 'SimpleFinError',
    code: 'NON_HTTPS_URL',
  });

  // Localhost host
  assert.throws(() => validateAccessUrl('https://demo:pass@localhost/simplefin'), {
    name: 'SimpleFinError',
    code: 'DISALLOWED_HOST',
  });

  // Private IP host
  assert.throws(() => validateAccessUrl('https://demo:pass@192.168.1.100/simplefin'), {
    name: 'SimpleFinError',
    code: 'DISALLOWED_HOST',
  });

  // Valid access URL instance passes through
  const a1 = new SimpleFinAccess(VALID_ACCESS_URL);
  const a2 = validateAccessUrl(a1);
  assert.equal(a1, a2);
});

// ==========================================
// 3. Fetching Accounts with balances-only=1 and version=2
// ==========================================

test('fetchAccounts queries balances-only=1 and version=2 with Basic Auth without credentials in URL', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;

  const mockPayload = {
    errlist: [],
    connections: [
      {
        conn_id: 'CON-1001',
        name: 'Chase Bank - Personal',
        org_id: 'ORG-CHASE',
        org_name: 'Chase',
      },
    ],
    accounts: [
      {
        id: 'ACT-5001',
        name: 'Sapphire Preferred Checking',
        conn_id: 'CON-1001',
        currency: 'USD',
        balance: '4250.75',
        'available-balance': '4100.50',
        'balance-date': 1711000000,
        transactions: [],
      },
      {
        id: 'ACT-5002',
        name: 'Freedom Savings',
        conn_id: 'CON-1001',
        currency: 'USD',
        balance: '12500.00',
        // omitted available-balance should default to balance
        'balance-date': 1711000000,
      },
    ],
  };

  const mockFetch = async (url, options) => {
    capturedUrl = new URL(url);
    capturedHeaders = options.headers;
    return mockResponse(mockPayload);
  };

  const result = await fetchAccounts(VALID_ACCESS_URL, { fetch: mockFetch });

  // URL must not expose credentials in url string
  assert.equal(capturedUrl.username, '');
  assert.equal(capturedUrl.password, '');
  assert.equal(capturedUrl.origin + capturedUrl.pathname, 'https://bridge.simplefin.org/simplefin/accounts');
  assert.equal(capturedUrl.searchParams.get('balances-only'), '1');
  assert.equal(capturedUrl.searchParams.get('version'), '2');

  // Basic auth header must be set correctly
  const expectedAuth = 'Basic ' + Buffer.from('demo_user:super_secret_pass_456').toString('base64');
  assert.equal(capturedHeaders.Authorization, expectedAuth);

  // Results check
  assert.equal(result.balancesOnly, true);
  assert.equal(result.version, 2);
  assert.equal(result.accounts.length, 2);

  const [acct1, acct2] = result.accounts;
  assert.equal(acct1.id, 'ACT-5001');
  assert.equal(acct1.name, 'Sapphire Preferred Checking');
  assert.equal(acct1.connectionName, 'Chase Bank - Personal');
  assert.equal(acct1.balance, 4250.75);
  assert.equal(acct1.balanceString, '4250.75');
  assert.equal(acct1.availableBalance, 4100.50);
  assert.equal(acct1.availableBalanceString, '4100.50');
  assert.equal(acct1.currencyMeta.type, 'standard');
  assert.equal(acct1.currencyMeta.code, 'USD');
  assert.deepEqual(acct1.transactions, []);

  // acct2 available balance defaults to balance
  assert.equal(acct2.availableBalance, 12500.00);
  assert.equal(acct2.availableBalanceString, '12500.00');
  assert.deepEqual(acct2.transactions, []);
});

test('fetchAccounts handles 403 on accounts endpoint safely', async () => {
  const mockFetch = async () => mockResponse('Forbidden', { status: 403 });

  await assert.rejects(
    () => fetchAccounts(VALID_ACCESS_URL, { fetch: mockFetch }),
    err => {
      assert.equal(err.name, 'SimpleFinAuthError');
      assert.equal(err.status, 403);
      assert.equal(err.code, 'ACCESS_REVOKED');
      assert.match(err.message, /access revoked|credentials invalid/i);
      return true;
    }
  );
});

test('fetchAccounts handles 402 Payment Required', async () => {
  const mockFetch = async () => mockResponse('Payment required', { status: 402 });

  await assert.rejects(
    () => fetchAccounts(VALID_ACCESS_URL, { fetch: mockFetch }),
    err => {
      assert.equal(err.name, 'SimpleFinError');
      assert.equal(err.status, 402);
      assert.equal(err.code, 'PAYMENT_REQUIRED');
      return true;
    }
  );
});

test('fetchAccounts rejects redirects on accounts endpoint', async () => {
  const mockFetch = async () =>
    mockResponse('', {
      status: 301,
      headers: { Location: 'https://attacker.example/accounts' },
    });

  await assert.rejects(
    () => fetchAccounts(VALID_ACCESS_URL, { fetch: mockFetch }),
    err => {
      assert.equal(err.name, 'SimpleFinError');
      assert.equal(err.status, 301);
      assert.equal(err.code, 'REDIRECT_DISALLOWED');
      return true;
    }
  );
});

// ==========================================
// 4. Structured errlist & Legacy Errors
// ==========================================

test('normalizeErrlist parses structured error objects and sanitizes messages', () => {
  const payload = {
    errlist: [
      {
        code: 'con.auth',
        msg: '<script>alert(1)</script>Bank authentication failed for Chase',
        conn_id: 'CON-1234',
      },
      {
        code: 'act.failed',
        msg: 'Failed to retrieve transactions for savings',
        account_id: 'ACT-9876',
      },
      {
        code: 'gen.api',
        msg: 'Invalid query parameter',
      },
      {
        code: 'custom.code.sub',
        msg: 'Custom error code handling',
      },
    ],
  };

  const parsed = normalizeErrlist(payload);
  assert.equal(parsed.length, 4);

  assert.equal(parsed[0].code, 'con.auth');
  assert.equal(parsed[0].prefix, 'con');
  assert.equal(parsed[0].subcode, 'auth');
  assert.equal(parsed[0].msg, 'Bank authentication failed for Chase'); // script tags stripped
  assert.equal(parsed[0].connId, 'CON-1234');

  assert.equal(parsed[1].code, 'act.failed');
  assert.equal(parsed[1].prefix, 'act');
  assert.equal(parsed[1].subcode, 'failed');
  assert.equal(parsed[1].accountId, 'ACT-9876');

  assert.equal(parsed[2].prefix, 'gen');
  assert.equal(parsed[2].subcode, 'api');

  assert.equal(parsed[3].prefix, 'custom');
  assert.equal(parsed[3].subcode, 'code.sub');
});

test('normalizeErrlist handles legacy deprecated errors array', () => {
  const payload = {
    errors: ['Legacy connection error message', '<b>Second error</b>'],
  };
  const parsed = normalizeErrlist(payload);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].code, 'gen.legacy');
  assert.equal(parsed[0].msg, 'Legacy connection error message');
  assert.equal(parsed[1].msg, 'Second error');
});

// ==========================================
// 5. Custom Currency Metadata & Sanitization
// ==========================================

test('fetchCustomCurrency fetches and sanitizes custom currency', async () => {
  const CURRENCY_URL = 'https://bridge.simplefin.org/currencies/delta-skymiles';

  const mockFetch = async url => {
    assert.equal(url, CURRENCY_URL);
    return mockResponse({
      name: '<script>evil()</script>Delta SkyMiles',
      abbr: '<b>miles</b>\x00',
    });
  };

  const meta = await fetchCustomCurrency(CURRENCY_URL, { fetch: mockFetch });
  assert.equal(meta.type, 'custom');
  assert.equal(meta.name, 'Delta SkyMiles');
  assert.equal(meta.abbr, 'miles');
  assert.equal(meta.url, CURRENCY_URL);
  assert.equal(meta.valid, true);
});

test('fetchCustomCurrency rejects non-HTTPS, private host, or redirects', async () => {
  // Non-HTTPS
  await assert.rejects(
    () => fetchCustomCurrency('http://bridge.simplefin.org/currency'),
    { name: 'SimpleFinError', code: 'NON_HTTPS_URL' }
  );

  // Disallowed host
  await assert.rejects(
    () => fetchCustomCurrency('https://127.0.0.1/currency'),
    { name: 'SimpleFinError', code: 'DISALLOWED_HOST' }
  );

  // Redirect
  const mockRedirect = async () => mockResponse('', { status: 302 });
  await assert.rejects(
    () => fetchCustomCurrency('https://bridge.simplefin.org/currency', { fetch: mockRedirect }),
    { name: 'SimpleFinError', code: 'REDIRECT_DISALLOWED' }
  );
});

test('normalizeAccount normalizes custom currency accounts with resolved metadata', () => {
  const customCurrencies = new Map([
    [
      'https://bridge.simplefin.org/currencies/united-mileageplus',
      { name: 'United MileagePlus', abbr: 'miles' },
    ],
  ]);

  const raw = {
    id: 'ACT-900',
    name: 'MileagePlus Rewards Card',
    currency: 'https://bridge.simplefin.org/currencies/united-mileageplus',
    balance: '85200',
    'balance-date': 1711000000,
  };

  const account = normalizeAccount(raw, { customCurrencies });
  assert.equal(account.isCustomCurrency, true);
  assert.equal(account.currencyMeta.type, 'custom');
  assert.equal(account.currencyMeta.name, 'United MileagePlus');
  assert.equal(account.currencyMeta.abbr, 'miles');
  assert.equal(account.currencyMeta.url, 'https://bridge.simplefin.org/currencies/united-mileageplus');
  assert.equal(account.balance, 85200);
});

test('normalizeAccount falls back gracefully if custom currency metadata is missing', () => {
  const raw = {
    id: 'ACT-901',
    name: 'Unknown Points Program',
    currency: 'https://bridge.simplefin.org/currencies/unknown-token',
    balance: '500',
    'balance-date': 1711000000,
  };

  const account = normalizeAccount(raw);
  assert.equal(account.isCustomCurrency, true);
  assert.equal(account.currencyMeta.name, 'Custom Currency');
  assert.equal(account.currencyMeta.abbr, 'pts');
});

// ==========================================
// 6. Secret Redaction & Safe Retention
// ==========================================

test('maskAccessUrl redacts the password from access URL', () => {
  const masked = maskAccessUrl('https://myuser:super_secret_password_999@bridge.simplefin.org/simplefin');
  assert.equal(masked, 'https://myuser:***@bridge.simplefin.org/simplefin');
  assert(!masked.includes('super_secret_password_999'));

  // Invalid input safely handled
  assert.equal(maskAccessUrl(null), '[REDACTED]');
  assert.equal(maskAccessUrl('not a url'), '[REDACTED]');
});

test('redactSecrets sanitizes URLs with credentials, Basic Auth, and Bearer tokens', () => {
  const sensitiveText =
    'Error connecting to https://alice:secret123@bridge.simplefin.org/endpoint with header Basic dXNlcjpwYXNz and Bearer token.xyz';
  const clean = redactSecrets(sensitiveText);

  assert(!clean.includes('secret123'));
  assert(!clean.includes('dXNlcjpwYXNz'));
  assert(!clean.includes('token.xyz'));
  assert.equal(
    clean,
    'Error connecting to https://alice:***@bridge.simplefin.org/endpoint with header Basic [REDACTED] and Bearer [REDACTED]'
  );
});

test('SimpleFinAccess does not expose credentials in JSON.stringify or util.inspect', () => {
  const access = new SimpleFinAccess(VALID_ACCESS_URL);

  const json = JSON.stringify(access);
  assert(!json.includes('super_secret_pass_456'));
  assert(json.includes('https://demo_user:***@bridge.simplefin.org/simplefin'));

  const inspected = util.inspect(access);
  assert(!inspected.includes('super_secret_pass_456'));
  assert(inspected.includes('https://demo_user:***@bridge.simplefin.org/simplefin'));

  // The password and raw URL are still accessible via getters for authorized storage
  assert.equal(access.password, 'super_secret_pass_456');
  assert.equal(access.accessUrl, VALID_ACCESS_URL);
});

test('SimpleFinError redacts credentials from error messages', () => {
  const err = new SimpleFinError(
    'Connection to https://bob:supersecret@bridge.simplefin.org failed with Basic abc123xyz=='
  );
  assert(!err.message.includes('supersecret'));
  assert(!err.message.includes('abc123xyz=='));
  assert.match(err.message, /https:\/\/bob:\*\*\*@bridge\.simplefin\.org/);
  assert.match(err.message, /Basic \[REDACTED\]/);
});

// ==========================================
// 7. Bounded Size & Timeout Enforcement
// ==========================================

test('safeFetch rejects responses exceeding maximum allowed size', async () => {
  // Mock a response with content-length larger than maxBytes
  const mockFetch = async () =>
    mockResponse('too big', {
      headers: { 'content-length': '1000000' },
    });

  await assert.rejects(
    () => claimAccessUrl(VALID_TOKEN, { fetch: mockFetch, maxBytes: 500 }),
    { name: 'SimpleFinError', code: 'MAX_SIZE_EXCEEDED' }
  );
});

test('safeFetch handles timeouts properly', async () => {
  const mockFetch = async (_url, options) => {
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
  };

  await assert.rejects(
    () => claimAccessUrl(VALID_TOKEN, { fetch: mockFetch, timeoutMs: 20 }),
    { name: 'SimpleFinError', code: 'TIMEOUT' }
  );
});

// ==========================================
// 8. SimpleFinClient High-Level Workflow
// ==========================================

test('SimpleFinClient initializes, claims, and fetches accounts', async () => {
  const mockFetch = async (url, options) => {
    if (options.method === 'POST') {
      return mockResponse(VALID_ACCESS_URL);
    }
    return mockResponse({
      errlist: [],
      connections: [],
      accounts: [
        {
          id: '123',
          name: 'Checking',
          currency: 'USD',
          balance: '100.00',
          'balance-date': 1700000000,
        },
      ],
    });
  };

  const client = await SimpleFinClient.claim(VALID_TOKEN, { fetch: mockFetch });
  assert.equal(client.baseUrl, 'https://bridge.simplefin.org/simplefin');
  assert.equal(client.maskedUrl, 'https://demo_user:***@bridge.simplefin.org/simplefin');

  // JSON serialization is safe
  const serialized = JSON.stringify(client);
  assert(!serialized.includes('super_secret_pass_456'));

  const data = await client.fetchAccounts();
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].name, 'Checking');
});
