// Backup & restore HTTP surface: export, preview (merge/replace review), restore, summary.
// createRoutes(deps) -> async ctx => null | { status, payload }, like the other feature packages.
// Staged previews live only in process memory (never on disk), expire after five minutes, are limited to two,
// and are consumed by a single restore. Decrypted data and passwords never reach logs or error text.
import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { BackupError, backupInvalid, decryptBackup, encryptBackup, passwordBuffer } from './backup.mjs';
import { CATEGORIES, buildPayload, defaultValidators, normalizeIncoming, parseCategories, planRestore } from './backup-schema.mjs';
import { TransactionError, replaceDocumentsAtomic as defaultReplace, snapshotDocuments as defaultSnapshot } from './store-transaction.mjs';

export const PREVIEW_TTL_MS = 5 * 60 * 1000;
export const MAX_PREVIEWS = 2;
const CHOICE_VALUES = ['keep', 'incoming', 'both'];
// Which documents a category reads or writes. Only these are hashed, so unrelated activity (an alert check
// updating alerts.json) does not make a wallet-only preview stale.
const CATEGORY_DOCUMENTS = { wallet: ['user'], preferences: ['user'], settings: ['settings'], plans: ['tripPlan', 'stayPlan'], alerts: ['alerts'] };

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const badRequest = (message, code = 'BACKUP_INVALID') => new ApiError(message, 400, code);

function exactKeys(body, allowed, what) {
  if (!isPlain(body)) throw badRequest(`${what} must be a JSON object.`);
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw badRequest(`${what} has unexpected fields.`);
}
const boolOption = (value, name) => {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw badRequest(`${name} must be true or false.`);
  return value;
};

function parseOptions(options) {
  if (options === undefined) return { restoreSecrets: false, activateImportedAlerts: false, enableLaunchAtLogin: false };
  exactKeys(options, ['restoreSecrets', 'activateImportedAlerts', 'enableLaunchAtLogin'], 'options');
  return { restoreSecrets: boolOption(options.restoreSecrets, 'restoreSecrets'), activateImportedAlerts: boolOption(options.activateImportedAlerts, 'activateImportedAlerts'), enableLaunchAtLogin: boolOption(options.enableLaunchAtLogin, 'enableLaunchAtLogin') };
}

function parseChoices(choices) {
  if (choices === undefined) return {};
  if (!isPlain(choices) || Object.keys(choices).length > 3000) throw badRequest('choices must be an object.');
  const out = {};
  for (const [id, value] of Object.entries(choices)) {
    if (id.length > 200 || !CHOICE_VALUES.includes(value)) throw badRequest('A conflict choice is not valid.');
    out[id] = value;
  }
  return out;
}

const dayStamp = ms => new Date(ms).toISOString().slice(0, 10);

function countsFromPayload(documents) {
  return {
    wallet: documents.user?.balances?.length ?? null,
    preferences: documents.user?.preferences ? Object.keys(documents.user.preferences).length : null,
    settings: documents.settings ? Object.keys(documents.settings.values).length : null,
    savedTrip: documents.tripPlan ? (documents.tripPlan.segments?.length || 0) : null,
    savedStays: documents.stayPlan ? documents.stayPlan.stays.length : null,
    alerts: documents.alerts ? documents.alerts.length : null
  };
}

export function createBackupService({
  snapshotDocuments = defaultSnapshot, replaceDocumentsAtomic = defaultReplace, withMonitorPaused = fn => fn(),
  validators = defaultValidators, now = () => Date.now(), appVersion = 'unknown', encrypt = encryptBackup, decrypt = decryptBackup,
  afterRestore = null, newPreviewId = () => randomBytes(32).toString('base64url'), newAlertId
} = {}) {
  const previews = new Map();

  function purge() {
    const t = now();
    for (const [id, p] of previews) if (p.expiresAt <= t) previews.delete(id);
  }

  async function exportBackup(body) {
    exactKeys(body, ['password', 'includeSecrets', 'categories'], 'The export request');
    const categories = parseCategories(body.categories);
    const includeSecrets = boolOption(body.includeSecrets, 'includeSecrets');
    passwordBuffer(body.password).fill(0); // validate before touching any data
    const snapshot = await snapshotDocuments();
    const { payload, warnings } = buildPayload({ documents: snapshot.documents, categories, includeSecrets, appVersion, now, validators });
    const envelope = await encrypt(payload, body.password);
    return { filename: `pointpilot-backup-${dayStamp(now())}.ppbackup`, envelope, includesSecrets: payload.includesSecrets, counts: countsFromPayload(payload.documents), warnings };
  }

  /** What an export of each category would contain right now (counts only, never values). */
  async function summary() {
    const snapshot = await snapshotDocuments();
    const { payload } = buildPayload({ documents: snapshot.documents, categories: CATEGORIES, includeSecrets: true, appVersion, now, validators });
    const secrets = payload.documents.settings?.secrets ? Object.keys(payload.documents.settings.secrets).length : 0;
    return { counts: countsFromPayload(payload.documents), secretsPresent: secrets > 0, categories: CATEGORIES };
  }

  async function preview(body) {
    exactKeys(body, ['password', 'envelope', 'previewId', 'mode', 'categories', 'choices', 'options'], 'The preview request');
    if (!['merge', 'replace'].includes(body.mode)) throw badRequest('Choose merge or replace.');
    const categories = parseCategories(body.categories);
    const choices = parseChoices(body.choices);
    const options = parseOptions(body.options);
    purge();

    let staged, source = body.previewId;
    if (body.previewId !== undefined) {
      if (body.envelope !== undefined || body.password !== undefined) throw badRequest('Send either the backup file and password, or a previous preview id.');
      const earlier = typeof body.previewId === 'string' ? previews.get(body.previewId) : null;
      if (!earlier) throw new ApiError('That preview expired. Choose the backup file again.', 409, 'PREVIEW_EXPIRED');
      staged = earlier.staged;
    } else {
      if (body.envelope === undefined || body.password === undefined) throw badRequest('Choose a backup file and enter its password.');
      const payload = await decrypt(body.envelope, body.password);
      staged = normalizeIncoming(payload, { validators });
      source = null;
    }

    const snapshot = await snapshotDocuments();
    const plan = planRestore({ current: snapshot.documents, staged, mode: body.mode, categories, choices, options, now: now(), newId: newAlertId, validators });
    const watched = new Set(plan.selected.flatMap(c => CATEGORY_DOCUMENTS[c]));
    const baseHashes = Object.fromEntries([...watched].map(name => [name, snapshot.hashes[name]]));

    if (source) previews.delete(source); // a changed review invalidates the earlier one
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
    const previewId = newPreviewId();
    const expiresAt = now() + PREVIEW_TTL_MS;
    previews.set(previewId, { staged, plan, baseHashes, mode: body.mode, categories, options, expiresAt, fromPrevious: Boolean(source) });
    const containsSecrets = staged.includesSecrets && Object.keys(staged.secrets).length > 0;
    return {
      previewId, expiresAt: new Date(expiresAt).toISOString(), baseRevision: snapshot.revision,
      backup: { createdAt: staged.createdAt, appVersion: staged.appVersion, categories: staged.categories },
      mode: body.mode, categories: plan.selected, options: plan.options,
      counts: plan.counts, conflicts: plan.conflicts, effects: plan.effects, warnings: plan.warnings,
      containsSecrets, sensitive: plan.sensitive
    };
  }

  async function restore(body) {
    exactKeys(body, ['previewId', 'restoreSecrets', 'activateImportedAlerts', 'enableLaunchAtLogin'], 'The restore request');
    purge();
    const entry = typeof body.previewId === 'string' ? previews.get(body.previewId) : null;
    if (!entry) throw new ApiError('That preview expired or was already used. Preview the backup again.', 409, 'PREVIEW_EXPIRED');
    previews.delete(body.previewId); // single use, whatever happens next
    const flags = { restoreSecrets: boolOption(body.restoreSecrets, 'restoreSecrets'), activateImportedAlerts: boolOption(body.activateImportedAlerts, 'activateImportedAlerts'), enableLaunchAtLogin: boolOption(body.enableLaunchAtLogin, 'enableLaunchAtLogin') };
    if (Object.keys(flags).some(k => flags[k] !== entry.options[k])) throw new ApiError('The review options changed. Preview the backup again.', 409, 'PREVIEW_OPTIONS_CHANGED');

    let result;
    try {
      result = await withMonitorPaused(() => replaceDocumentsAtomic({ after: entry.plan.after, baseHashes: entry.baseHashes }));
    } catch (e) {
      if (e instanceof TransactionError && e.code === 'STALE') throw new ApiError('Your data changed after the preview. Preview the backup again.', 409, 'PREVIEW_STALE');
      if (e instanceof TransactionError) throw new ApiError(e.message, 500, 'BACKUP_RESTORE_FAILED');
      if (e instanceof ApiError) throw e;
      throw new ApiError('The restore failed. Your previous data was not changed unless PointPilot says otherwise.', 500, 'BACKUP_RESTORE_FAILED');
    }
    const appliedCounts = Object.fromEntries(Object.entries(entry.plan.counts).map(([category, c]) => [category, c.add + c.update + c.remove]));
    await afterRestore?.({ changed: result.changed, sensitive: entry.plan.sensitive })?.catch?.(() => {});
    return { ok: true, appliedCounts, changedDocuments: result.changed, revision: result.revision, warnings: entry.plan.warnings };
  }

  return { exportBackup, summary, preview, restore, _previews: previews };
}

export function createRoutes(deps = {}) {
  const service = deps.service || createBackupService({ appVersion: deps.version, now: deps.now, withMonitorPaused: deps.withMonitorPaused, afterRestore: deps.afterRestore, validators: deps.validators });
  return async function handle(ctx) {
    if (!ctx.path.startsWith('/api/backup/')) return null;
    if (ctx.method === 'GET' && ctx.path === '/api/backup/summary') return { status: 200, payload: await service.summary() };
    if (ctx.method !== 'POST') return null;
    switch (ctx.path) {
      case '/api/backup/export': return { status: 200, payload: await service.exportBackup(ctx.body) };
      case '/api/backup/preview': return { status: 200, payload: await service.preview(ctx.body) };
      case '/api/backup/restore': return { status: 200, payload: await service.restore(ctx.body) };
      default: return null;
    }
  };
}

export { BackupError, backupInvalid };
