// PointPilot-side mapping from SimpleFIN custom reward currencies to canonical wallet programs.
import crypto from 'node:crypto';
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { loadUser, saveUser } from './settings.mjs';
import { programId, programName, programKind } from './programs.mjs';

const FILE = () => dataFile('simplefin-wallet.json');
const EMPTY = () => ({ mappings: {}, accounts: [], errors: [], lastFetchedAt: null, lastSyncedAt: null });

export function simpleFinAccountKey(account) {
  return crypto.createHash('sha256').update(`${account.connId || account.connectionId || account.conn_id || ''}\0${account.id || ''}`).digest('hex');
}

const safeLabel = (value, fallback) => {
  const text = [...String(value || '')].filter(char => { const code = char.charCodeAt(0); return code > 31 && code !== 127; }).join('').trim().slice(0, 120);
  return text || fallback;
};

export function projectRewardAccounts(accounts) {
  if (!Array.isArray(accounts)) throw Object.assign(new Error('SimpleFIN returned an invalid account list.'), { status: 502 });
  return accounts.slice(0, 500).map(account => {
    const currency = String(account.currency || '');
    // Standard ISO currency accounts are checking/credit-card money balances, not loyalty points.
    const rewardsCurrency = account.isCustomCurrency === true || /^https:\/\//i.test(currency);
    const balance = Number(account.balance);
    const balanceDateSeconds = account.balanceDate ? Date.parse(account.balanceDate) / 1000 : Number(account.balanceTimestamp ?? account['balance-date']);
    const balanceAtMs = balanceDateSeconds * 1000;
    return {
      key: simpleFinAccountKey(account),
      name: safeLabel(account.name, 'Unnamed account'),
      rewardsCurrency,
      currencyName: rewardsCurrency ? safeLabel(account.currencyMeta?.name || account.currencyName || account.currency_name, 'Custom rewards currency') : safeLabel(currency, 'Unknown currency'),
      currencyAbbr: rewardsCurrency ? safeLabel(account.currencyMeta?.abbr || account.currencyAbbr || account.currency_abbr, 'points').slice(0, 20) : currency.slice(0, 12),
      balance: Number.isFinite(balance) && balance >= 0 ? balance : null,
      balanceAt: Number.isFinite(balanceAtMs) && balanceAtMs > 0 && balanceAtMs <= 8640000000000000 ? new Date(balanceAtMs).toISOString() : null
    };
  });
}

export async function getSimpleFinWalletState() {
  const state = await readJson(FILE(), EMPTY());
  return { ...EMPTY(), ...state };
}

export async function saveSimpleFinSnapshot(accounts, at = new Date().toISOString(), errors = []) {
  const projected = projectRewardAccounts(accounts);
  return updateJson(FILE(), EMPTY(), state => ({ ...EMPTY(), ...state, accounts: projected, errors: Array.isArray(errors) ? errors.slice(0, 100) : [], lastFetchedAt: at }));
}

export async function saveSimpleFinMappings(input) {
  if (!Array.isArray(input) || input.length > 500) throw Object.assign(new Error('Choose valid SimpleFIN account mappings.'), { status: 400 });
  const current = await getSimpleFinWalletState();
  const allowed = new Set(current.accounts.filter(account => account.rewardsCurrency).map(account => account.key));
  const mappings = {};
  for (const item of input) {
    if (!item || typeof item !== 'object' || !/^[a-f0-9]{64}$/.test(item.key || '') || !allowed.has(item.key)) throw Object.assign(new Error('A selected account is no longer available. Refresh the SimpleFIN account list.'), { status: 400 });
    if (item.program == null || item.program === '') continue;
    const code = programId(item.program);
    if (!code) throw Object.assign(new Error('Choose a supported loyalty program for each points account.'), { status: 400 });
    mappings[item.key] = code;
  }
  const next = await updateJson(FILE(), EMPTY(), state => ({ ...EMPTY(), ...state, mappings }));
  return publicSimpleFinWalletState(next);
}

export function publicSimpleFinWalletState(state, connected = undefined) {
  return {
    connected,
    accounts: (state.accounts || []).map(account => ({ ...account, program: state.mappings?.[account.key] || null })),
    lastFetchedAt: state.lastFetchedAt || null,
    lastSyncedAt: state.lastSyncedAt || null,
    errors: Array.isArray(state.errors) ? state.errors : []
  };
}

export async function syncSimpleFinBalances() {
  const state = await getSimpleFinWalletState();
  const totals = new Map();
  for (const account of state.accounts) {
    const code = state.mappings?.[account.key];
    if (!code || !account.rewardsCurrency) continue;
    if (!Number.isSafeInteger(account.balance) || account.balance < 0) {
      throw Object.assign(new Error(`The mapped SimpleFIN account “${account.name}” does not have a whole-number points balance.`), { status: 422 });
    }
    totals.set(code, (totals.get(code) || 0) + account.balance);
    if (!Number.isSafeInteger(totals.get(code))) throw Object.assign(new Error('Mapped SimpleFIN balances exceed the supported wallet limit.'), { status: 422 });
  }
  if (!totals.size) throw Object.assign(new Error('Map at least one custom rewards account to a loyalty program before syncing.'), { status: 400 });
  const user = await loadUser();
  const balances = user.balances.map(balance => ({ ...balance }));
  const syncedPrograms = [];
  for (const [code, balance] of totals) {
    const old = balances.find(row => row.code === code);
    const value = { program: programName(code), code, type: programKind(code), balance, cpp: old?.cpp ?? user.preferences?.defaultCpp ?? 1.5, transferable: programKind(code) === 'bank' };
    const index = balances.findIndex(row => row.code === code);
    if (index >= 0) balances[index] = value; else balances.push(value);
    syncedPrograms.push({ code, program: value.program, balance });
  }
  const saved = await saveUser({ balances, preferences: user.preferences || {} });
  const next = await updateJson(FILE(), EMPTY(), prior => ({ ...EMPTY(), ...prior, lastSyncedAt: new Date().toISOString() }));
  return { user: saved, sync: { programs: syncedPrograms, source: 'SimpleFIN', savedAt: next.lastSyncedAt } };
}

export async function clearSimpleFinWalletState() {
  return updateJson(FILE(), EMPTY(), () => EMPTY());
}
