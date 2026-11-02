'use strict';
// Place autocomplete for any <input data-places>. Suggestions come from /api/places/suggest and include
// "all airports" entries for countries and cities. The last comma-separated token is the one completed.
(function () {
  let list = null, active = -1, items = [], input = null, timer = null, seq = 0;

  function ensureList() {
    if (list) return list;
    list = document.createElement('ul');
    list.id = 'placeSuggestList'; list.className = 'place-suggest'; list.setAttribute('role', 'listbox'); list.hidden = true;
    list.addEventListener('mousedown', e => { e.preventDefault(); const li = e.target.closest('li[data-i]'); if (li) pick(Number(li.dataset.i)); });
    document.body.appendChild(list);
    return list;
  }

  function close() {
    seq += 1; clearTimeout(timer);
    if (list) list.hidden = true;
    if (input) { input.removeAttribute('aria-expanded'); input.removeAttribute('aria-activedescendant'); }
    active = -1; items = [];
  }

  function highlight(i) {
    active = items.length ? (i + items.length) % items.length : -1;
    [...list.children].forEach((li, n) => { li.classList.toggle('active', n === active); li.setAttribute('aria-selected', String(n === active)); });
    if (active >= 0) { input.setAttribute('aria-activedescendant', `place-opt-${active}`); list.children[active].scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }

  function render() {
    const ul = ensureList();
    ul.textContent = '';
    items.forEach((s, i) => {
      const li = document.createElement('li');
      li.id = `place-opt-${i}`; li.dataset.i = String(i); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
      const code = document.createElement('strong'); code.textContent = s.kind === 'all' ? s.value : s.code;
      const detail = document.createElement('span'); detail.textContent = s.detail;
      li.append(code, detail); ul.appendChild(li);
    });
    const r = input.getBoundingClientRect();
    ul.style.left = `${r.left + window.scrollX}px`; ul.style.top = `${r.bottom + window.scrollY + 2}px`; ul.style.minWidth = `${r.width}px`;
    ul.hidden = !items.length;
    input.setAttribute('aria-controls', ul.id); input.setAttribute('aria-expanded', String(items.length > 0));
    highlight(-1);
  }

  function pick(i) {
    const s = items[i]; if (!s || !input) return;
    const target = input, parts = target.value.split(/([,;/])/);
    parts[parts.length - 1] = `${parts.length > 1 ? ' ' : ''}${s.value}`;
    target.value = parts.join('');
    close();
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    // A change handler may redraw the field; keep the caret in the (possibly new) element.
    const again = document.getElementById(target.id); if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  }

  async function fetchSuggestions(el) {
    const mine = ++seq;
    try {
      const res = await fetch(`/api/places/suggest?q=${encodeURIComponent(el.value)}`);
      if (!res.ok || mine !== seq || document.activeElement !== el) return;
      items = (await res.json()).suggestions || [];
      input = el; render();
    } catch { /* suggestions are optional */ }
  }

  document.addEventListener('input', e => {
    const el = e.target;
    if (!el.matches || !el.matches('input[data-places]') || !e.isTrusted) return;
    input = el; clearTimeout(timer);
    if (el.value.split(/[,;/]+/).pop().trim().length < 2) return close();
    timer = setTimeout(() => fetchSuggestions(el), 120);
  });
  document.addEventListener('keydown', e => {
    if (!list || list.hidden || e.target !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); highlight(active + (e.key === 'ArrowDown' ? 1 : -1)); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }, true);
  document.addEventListener('focusout', e => { if (e.target === input) setTimeout(close, 100); });
  window.addEventListener('resize', close);
})();
