'use strict';
// Small shared helpers for the feature screens (itinerary, readiness, backup, diagnostics).
// Classic script, loaded before the feature scripts and app.js. The functions that touch the DOM only
// run inside a browser; everything else is pure so tests can evaluate this file against a bare global.
(function (root) {
  const MAX_ERROR_TEXT = 300;

  /** "Oct 20, 2026, 9:14 PM", or "unknown" when the value is not a usable timestamp. */
  function whenLabel(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 'unknown';
    return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /** "just now", "5 min ago", "2 h ago", "3 d ago". */
  function ageLabel(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 'unknown time';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  const fmtInt = n => new Intl.NumberFormat('en-US').format(Math.round(Number(n) || 0));

  /** A short, safe message for an error. Known codes get friendly text; anything else is truncated. */
  function errorMessage(error, byCode = {}, fallback = 'Something went wrong.') {
    if (error && error.code && byCode[error.code]) return byCode[error.code];
    if (error && error.status && byCode[error.status]) return byCode[error.status];
    const text = [...String((error && error.message) || fallback)].map(c => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, MAX_ERROR_TEXT);
  }

  /** Password rule shared with the server: at least 12 characters, at most 1,024 UTF-8 bytes. */
  function passwordProblem(password) {
    const text = String(password ?? '').normalize('NFKC');
    if ([...text].length < 12) return 'Use at least 12 characters.';
    const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
    if (bytes > 1024) return 'That password is too long (limit 1,024 bytes).';
    return null;
  }

  /** Rendered once per screen update; keeps keyboard focus on the same `data-focus` control. */
  function renderInto(el, html) {
    const doc = typeof document !== 'undefined' ? document : null;
    const active = doc && doc.activeElement && el.contains && el.contains(doc.activeElement) ? doc.activeElement : null;
    const key = active && active.dataset ? active.dataset.focus : null;
    const range = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    el.innerHTML = html;
    if (key && el.querySelector) {
      const next = el.querySelector(`[data-focus="${String(key).replace(/["\\]/g, '')}"]`);
      if (next && typeof next.focus === 'function') {
        next.focus({ preventScroll: true });
        if (range && typeof next.setSelectionRange === 'function') { try { next.setSelectionRange(range[0], range[1]); } catch { /* not a text control */ } }
      }
    }
  }

  /** Offer text as a file download in a plain browser (the desktop app uses its native save dialog). */
  function downloadText(filename, text, mime = 'application/json') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Read a user-chosen File as text, refusing anything over the limit before it is read. */
  async function readFileText(file, maxBytes) {
    if (!file) throw Object.assign(new Error('No file chosen.'), { code: 'NO_FILE' });
    if (file.size > maxBytes) throw Object.assign(new Error('That file is too large.'), { code: 'FILE_TOO_LARGE' });
    return (await file.text()).replace(/^\uFEFF/, '');
  }

  /** Name of the filename PointPilot suggests for browser downloads, e.g. pointpilot-backup-2026-10-20.ppbackup. */
  const safeFilename = (name, fallback) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(String(name || '')) ? name : fallback);

  /** Wrap an async handler so a rejected promise surfaces as visible text instead of an unhandled rejection. */
  const guarded = (fn, onError) => (...args) => Promise.resolve().then(() => fn(...args)).catch(onError);

  const api = { whenLabel, ageLabel, plural, fmtInt, errorMessage, passwordProblem, renderInto, downloadText, readFileText, safeFilename, guarded };
  root.PPKit = api;
})(typeof window !== 'undefined' ? window : globalThis);
