// BelegCheck – Frontend (ohne Framework, ohne Build-Schritt)
'use strict';

/* ================= Hilfsfunktionen ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (c) => ((c || 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const eurPlain = (c) => (c == null || c === '' ? '' : (c / 100).toFixed(2).replace('.', ','));
const unitLabel = (u) => ({ kg: '/kg', l: '/l' }[u] || '/Stk');
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shortMonth = (m) => MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3);
const dateDE = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
function shiftMonth(m, delta) {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
// "2,99" / "2.99" / "1.234,50" -> Cent
function parseEuro(v) {
  let s = String(v ?? '').replace(/[\s€]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const parseNum = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

function toast(msg, ms = 2500) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

class AuthError extends Error {}
// api(...) kommt aus local-api.js (alle Daten lokal auf dem iPhone)

/* ================= Zustand ================= */
const state = {
  meta: null,            // Kategorien vom Server
  month: todayISO().slice(0, 7),
  days: 90,
  photos: [],            // aufgenommene Fotos (Base64)
  draft: null,           // Beleg im Prüf-Bildschirm
  draftInfo: null,       // { duplicateOf, editId }
  productsCache: null,
};

/* ================= Router ================= */
const routes = [
  [/^#?\/?$/, home],
  [/^#\/produkte$/, productsView],
  [/^#\/produkt\/(.+)$/, productDetail],
  [/^#\/scan$/, scanView],
  [/^#\/pruefen$/, reviewView],
  [/^#\/belege$/, receiptsView],
  [/^#\/beleg\/(\d+)$/, receiptDetail],
  [/^#\/beleg\/(\d+)\/bearbeiten$/, receiptEdit],
  [/^#\/mehr$/, moreView],
];

async function render() {
  if (!state.meta) {
    state.meta = await api('/api/me');
    state.hasKey = !!(await DB.setting('geminiKey'));
  }
  $('#tabs').classList.remove('hidden');
  view.oninput = null;
  const hash = location.hash || '#/';
  const tab = hash.split('/')[1] || '';
  const tabName = { '': 'home', produkte: 'produkte', produkt: 'produkte', scan: 'scan', pruefen: 'scan', belege: 'belege', beleg: 'belege', mehr: 'mehr' }[tab];
  $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tabName));
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(...m.slice(1).map(decodeURIComponent)); }
      catch (e) {
        view.innerHTML = `<div class="card"><h2>Fehler</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Zur Übersicht</a></div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', render);
const loading = (text = 'Lädt …') => { view.innerHTML = `<div class="spinner"></div><p class="empty">${esc(text)}</p>`; };

/* ================= Übersicht ================= */
function monthNav(onChange) {
  const isNow = state.month === todayISO().slice(0, 7);
  const el = document.createElement('div');
  el.className = 'monthnav';
  el.innerHTML = `<button aria-label="Vormonat">‹</button><h2 style="margin:0">${monthName(state.month)}</h2>
    <button aria-label="Nächster Monat" ${isNow ? 'style="visibility:hidden"' : ''}>›</button>`;
  const [prev, next] = $$('button', el);
  prev.onclick = () => { state.month = shiftMonth(state.month, -1); onChange(); };
  next.onclick = () => { state.month = shiftMonth(state.month, 1); onChange(); };
  return el;
}

function hbars(rows, labelKey, valueKey, total, extra = () => '') {
  const max = Math.max(1, ...rows.map((r) => r[valueKey]));
  return rows.map((r) => `
    <div class="hbar">
      <div class="top"><span class="ellipsis">${esc(r[labelKey])}${extra(r)}</span>
        <span class="num">${eur(r[valueKey])}${total ? ` <span class="muted small">${Math.round((r[valueKey] / total) * 100)} %</span>` : ''}</span></div>
      <div class="track"><div class="fill" style="width:${(r[valueKey] / max) * 100}%"></div></div>
    </div>`).join('');
}

// Senkrechte Balken mit Antippen-Tooltip (eine Datenreihe, eine Farbe)
function vbars(points, { height = 120, highlight } = {}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return `<div class="bars" style="height:${height}px">${points.map((p) => `
    <div class="b ${p.value <= 0 ? 'zero' : ''} ${p.key === highlight ? 'today' : ''}"
         style="height:${p.value > 0 ? Math.max(3, (p.value / max) * 100) : 0}%"
         data-tip="${esc(p.tip)}"></div>`).join('')}</div>`;
}
function wireTips(root) {
  $$('.bars', root).forEach((bars) => {
    bars.addEventListener('click', (ev) => {
      // Treffer über die ganze Spalte, nicht nur den (evtl. winzigen) Balken
      const cols = $$('.b', bars);
      const rect = bars.getBoundingClientRect();
      const idx = Math.min(cols.length - 1, Math.max(0, Math.floor(((ev.clientX - rect.left) / rect.width) * cols.length)));
      $$('.tip', bars).forEach((t) => t.remove());
      const b = cols[idx];
      const tip = document.createElement('div');
      tip.className = 'tip'; tip.textContent = b.dataset.tip;
      tip.style.left = `${Math.min(82, Math.max(18, ((idx + 0.5) / cols.length) * 100))}%`;
      tip.style.bottom = '100%';
      bars.appendChild(tip);
      setTimeout(() => tip.remove(), 2500);
    });
  });
}

async function home() {
  loading();
  const today = todayISO();
  const [s, p] = await Promise.all([
    api(`/api/summary?month=${state.month}&today=${today}`),
    api(`/api/products?days=90&today=${today}`),
  ]);
  state.productsCache = p;
  const isNow = s.month === today.slice(0, 7);

  view.innerHTML = '';
  if (!state.hasKey) {
    view.insertAdjacentHTML('beforeend', `<a class="card tap" href="#/mehr" style="border:2px solid var(--accent)">
      <b>Einrichtung (einmalig, 3 Minuten)</b><br><span class="muted small">Kostenlosen Gemini-API-Schlüssel eintragen, damit Bons automatisch gelesen werden. ›</span></a>`);
  }
  view.appendChild(monthNav(home));

  if (!s.receiptCount) {
    view.insertAdjacentHTML('beforeend', `
      <div class="card empty">
        <p style="font-size:40px;margin:0">🧾</p>
        <p><b>Noch keine Belege in diesem Monat.</b><br>Scanne deinen ersten Kassenbon – die Auswertung entsteht automatisch.</p>
        <a class="btn primary big" href="#/scan">Beleg scannen</a>
      </div>`);
    return;
  }

  // Vergleich zum Vormonat (bis zum selben Tag, im laufenden Monat)
  const cmpBase = isNow ? s.prevSameDaySum : s.prevMonthSum;
  let delta = '';
  if (cmpBase > 0) {
    const pct = Math.round(((s.monthSum - cmpBase) / cmpBase) * 100);
    delta = `<span class="${pct > 0 ? 'delta-up' : 'delta-down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)} %</span>
      <span class="muted small">vs. ${shortMonth(s.prevMonth)}${isNow ? ' (gleicher Zeitraum)' : ''}</span>`;
  }

  const days = Array.from({ length: s.daysInMonth }, (_, i) => {
    const key = `${s.month}-${pad(i + 1)}`;
    const v = s.byDay.find((d) => d.day === key)?.sum || 0;
    return { key, value: v, tip: `${i + 1}. ${shortMonth(s.month)}: ${eur(v)}` };
  });
  const cats = s.byCategory.filter((c) => c.sum > 0);
  const catTotal = cats.reduce((a, c) => a + c.sum, 0);
  const brandSum = s.brandSplit.reduce((a, b) => a + b.sum, 0);
  const own = s.brandSplit.find((b) => b.brand_type === 'eigenmarke')?.sum || 0;
  const trend = Array.from({ length: 6 }, (_, i) => {
    const m = shiftMonth(s.month, i - 5);
    const v = s.trend.find((t) => t.month === m)?.sum || 0;
    return { key: m, value: v, tip: `${monthName(m)}: ${eur(v)}` };
  });

  view.insertAdjacentHTML('beforeend', `
    <div class="card">
      <div class="hero-label">Ausgaben ${isNow ? 'diesen Monat' : monthName(s.month)}</div>
      <div class="hero num">${eur(s.monthSum)}</div>
      <div>${delta}</div>
      <div class="kpis">
        ${isNow ? `<div class="kpi"><span>Heute</span><b class="num">${eur(s.todaySum)}</b></div>` : ''}
        <div class="kpi"><span>Ø pro Tag</span><b class="num">${eur(s.avgPerDay)}</b></div>
        ${isNow ? `<div class="kpi"><span>Prognose Monatsende</span><b class="num">${eur(s.forecast)}</b></div>` : `<div class="kpi"><span>Belege</span><b class="num">${s.receiptCount}</b></div>`}
        <div class="kpi"><span>Vormonat gesamt</span><b class="num">${eur(s.prevMonthSum)}</b></div>
      </div>
    </div>

    ${p.totalSaving > 0 ? `
    <a class="card tap" href="#/produkte">
      <div class="row between"><div>
        <div class="hero-label">Sparpotenzial (hochgerechnet)</div>
        <div style="font-size:26px;font-weight:700" class="num">≈ ${eur(p.totalSavingPerYear)} / Jahr</div>
        <div class="muted small">wenn du ${p.savings.length} Produkt${p.savings.length > 1 ? 'e' : ''} im günstigsten Geschäft kaufst</div>
      </div><span class="muted" style="font-size:22px">›</span></div>
    </a>` : ''}

    <div class="card">
      <h2>Ausgaben pro Tag</h2>
      ${vbars(days, { highlight: isNow ? today : null })}
      <div class="bars-x"><span>1.</span><span>10.</span><span>20.</span><span>${s.daysInMonth}.</span></div>
      <p class="muted small" style="margin:8px 0 0">Balken antippen für den Betrag. ${s.receiptCount} Beleg${s.receiptCount > 1 ? 'e' : ''}.</p>
    </div>

    <div class="card">
      <h2>Kategorien</h2>
      ${hbars(cats, 'category', 'sum', catTotal)}
    </div>

    <div class="card">
      <h2>Top-Produkte</h2>
      ${s.topProducts.length ? hbars(s.topProducts, 'product_name', 'sum', 0, (r) => ` <span class="muted small">${r.purchases}×</span>`) : '<p class="muted">Keine Produktdaten.</p>'}
      <a class="link" href="#/produkte">Alle Produkte ›</a>
    </div>

    <div class="card">
      <h2>Geschäfte</h2>
      ${hbars(s.byStore, 'store', 'sum', s.monthSum, (r) => ` <span class="muted small">${r.visits}×</span>`)}
      ${brandSum > 0 ? `<p class="muted small" style="margin-bottom:0">Eigenmarken-Anteil: <b>${Math.round((own / brandSum) * 100)} %</b> deiner Produktausgaben.</p>` : ''}
    </div>

    <div class="card">
      <h2>Letzte 6 Monate</h2>
      ${vbars(trend, { height: 90 })}
      <div class="bars-x">${trend.map((t) => `<span>${shortMonth(t.key)}</span>`).join('')}</div>
    </div>`);
  wireTips(view);
}

/* ================= Scannen ================= */
async function resizeImage(file, max = 2000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild konnte nicht geladen werden')); i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    return { mediaType: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl };
  } finally { URL.revokeObjectURL(url); }
}

async function addFiles(files) {
  for (const f of files) {
    if (state.photos.length >= 4) { toast('Maximal 4 Fotos pro Beleg'); break; }
    try { state.photos.push(await resizeImage(f)); } catch (e) { toast(e.message); }
  }
  if (location.hash === '#/scan') scanView(); else location.hash = '#/scan';
}
$('#cam').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
$('#lib').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

function scanView() {
  const n = state.photos.length;
  view.innerHTML = `
    <h1>Beleg scannen</h1>
    ${n === 0 ? `
      <div class="card">
        <p class="muted" style="margin-top:0">Bon flach auf einen dunklen Untergrund legen, gut beleuchten und formatfüllend fotografieren.
        Bei langen Bons einfach mehrere Fotos machen (max. 4).</p>
        <button class="btn primary big" id="takePhoto">📷 Foto aufnehmen</button>
        <button class="btn" id="pickPhoto">Aus Fotos wählen</button>
      </div>` : `
      <div class="card">
        <div class="thumbs">${state.photos.map((p, i) => `<img src="${p.preview}" alt="Foto ${i + 1}">`).join('')}</div>
        <button class="btn primary big" id="analyze">Auswerten</button>
        ${n < 4 ? '<button class="btn" id="takePhoto">+ Weiteres Foto (langer Bon)</button>' : ''}
        <button class="btn danger" id="discard">Verwerfen</button>
      </div>`}`;
  $('#takePhoto')?.addEventListener('click', () => $('#cam').click());
  $('#pickPhoto')?.addEventListener('click', () => $('#lib').click());
  $('#discard')?.addEventListener('click', () => { state.photos = []; scanView(); });
  $('#analyze')?.addEventListener('click', analyze);
}

async function analyze() {
  loading('Bon wird gelesen … (ca. 5–20 Sekunden)');
  $('#tabs').classList.add('hidden');
  try {
    const res = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ images: state.photos.map(({ mediaType, data }) => ({ mediaType, data })) }),
    });
    state.draft = res.receipt;
    state.draftInfo = { duplicateOf: res.duplicateOf, editId: null };
    state.photos = [];
    location.hash = '#/pruefen';
  } catch (e) {
    $('#tabs').classList.remove('hidden');
    view.innerHTML = `<h1>Beleg scannen</h1><div class="card"><div class="notice">${esc(e.message)}</div>
      <button class="btn primary" id="retry">Erneut versuchen</button><button class="btn danger" id="discard">Fotos verwerfen</button></div>`;
    $('#retry').onclick = analyze;
    $('#discard').onclick = () => { state.photos = []; scanView(); };
  }
}

/* ================= Prüfen & Speichern ================= */
const opt = (list, sel) => list.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');

function reviewView() {
  const r = state.draft;
  if (!r) { location.hash = '#/scan'; return; }
  const info = state.draftInfo || {};
  const cats = state.meta.categories;
  view.innerHTML = `
    <h1>${info.editId ? 'Beleg bearbeiten' : 'Beleg prüfen'}</h1>
    ${info.duplicateOf ? `<div class="notice">Ein Beleg mit gleichem Geschäft, Datum und Betrag existiert bereits. <a href="#/beleg/${info.duplicateOf}">Ansehen</a></div>` : ''}
    ${r.hinweis ? `<div class="notice">Hinweis der Erkennung: ${esc(r.hinweis)}</div>` : ''}
    <div class="card">
      <div class="grid2">
        <div><label>Geschäft</label><input id="f_store" value="${esc(r.store)}"></div>
        <div><label>Datum</label><input id="f_date" type="date" value="${esc(r.purchase_date)}"></div>
      </div>
      <div class="grid2">
        <div><label>Bon-Summe (€)</label><input id="f_total" inputmode="decimal" value="${eurPlain(r.total_cents)}"></div>
        <div><label>Art</label><select id="f_scat">${opt(state.meta.storeCategories, r.store_category)}</select></div>
      </div>
      <div id="sumcheck"></div>
    </div>
    <div class="card" id="items">
      <h2>${r.items.length} Positionen</h2>
      ${r.items.map((it, i) => `
        <div class="item" data-i="${i}">
          <div class="raw">${esc(it.raw_name)}${it.learned ? ' <span class="learned">✓ gelernt</span>' : ''}</div>
          <div class="main">
            <input class="i_name" value="${esc(it.product_name)}" aria-label="Produkt">
            <input class="i_total amount num" inputmode="decimal" value="${eurPlain(it.total_cents)}" aria-label="Betrag">
          </div>
          <details>
            <summary>${esc(it.category)} · ${String(it.quantity ?? 1).replace('.', ',')} ${esc(it.unit || 'stk')} ›</summary>
            <label>Kategorie</label><select class="i_cat">${opt(cats, it.category)}</select>
            <div class="grid3">
              <div><label>Menge</label><input class="i_qty" inputmode="decimal" value="${String(it.quantity ?? 1).replace('.', ',')}"></div>
              <div><label>Einheit</label><select class="i_unit">${opt(['stk', 'kg', 'l'], it.unit || 'stk')}</select></div>
              <div><label>Einzelpreis</label><input class="i_unitprice" inputmode="decimal" value="${eurPlain(it.unit_price_cents)}"></div>
            </div>
            <label>Markentyp</label><select class="i_brand">${['unbekannt', 'eigenmarke', 'marke'].map((b) => `<option value="${b}" ${b === it.brand_type ? 'selected' : ''}>${{ unbekannt: 'unbekannt', eigenmarke: 'Eigenmarke', marke: 'Marke' }[b]}</option>`).join('')}</select>
            <button class="btn danger i_del" type="button">Position löschen</button>
          </details>
        </div>`).join('')}
      <button class="btn" id="addItem" type="button" style="margin-top:10px">+ Position hinzufügen</button>
    </div>
    <button class="btn primary big" id="save">Speichern</button>
    <button class="btn danger" id="cancel">Verwerfen</button>`;

  const updateSum = () => {
    const d = readDraft();
    const sum = d.items.reduce((a, it) => a + it.total_cents, 0);
    const diff = sum - d.total_cents;
    $('#sumcheck').innerHTML = Math.abs(diff) <= 1
      ? `<div class="ok">✓ Positionen ergeben die Bon-Summe (${eur(sum)})</div>`
      : `<div class="notice">Positionen: ${eur(sum)} – Bon-Summe: ${eur(d.total_cents)} (Differenz ${eur(diff)}). Bitte prüfen.</div>`;
  };
  view.oninput = updateSum;
  updateSum();

  $$('.i_del').forEach((b) => b.onclick = () => {
    state.draft = readDraft();
    state.draft.items.splice(Number(b.closest('.item').dataset.i), 1);
    reviewView();
  });
  $('#addItem').onclick = () => {
    state.draft = readDraft();
    state.draft.items.push({ raw_name: '', product_name: '', category: 'Sonstiges', brand_type: 'unbekannt', quantity: 1, unit: 'stk', total_cents: 0 });
    reviewView();
    const items = $$('.item'); items[items.length - 1].querySelector('.i_name').focus();
  };
  $('#cancel').onclick = () => {
    if (!confirm('Beleg wirklich verwerfen?')) return;
    const id = info.editId; state.draft = null; state.draftInfo = null;
    location.hash = id ? `#/beleg/${id}` : '#/';
  };
  $('#save').onclick = async () => {
    const d = readDraft();
    const btn = $('#save'); btn.disabled = true; btn.textContent = 'Speichert …';
    try {
      const res = info.editId
        ? await api(`/api/receipts/${info.editId}`, { method: 'PUT', body: JSON.stringify(d) })
        : await api('/api/receipts', { method: 'POST', body: JSON.stringify(d) });
      state.draft = null; state.draftInfo = null;
      toast('Beleg gespeichert ✓');
      location.hash = info.editId ? `#/beleg/${res.id}` : '#/';
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Speichern';
      toast(e.message, 4000);
    }
  };
}

function readDraft() {
  const r = state.draft;
  return {
    ...r,
    store: $('#f_store').value.trim(),
    purchase_date: $('#f_date').value,
    total_cents: parseEuro($('#f_total').value),
    store_category: $('#f_scat').value,
    items: $$('.item').map((el) => {
      const orig = r.items[Number(el.dataset.i)] || {};
      const name = $('.i_name', el).value.trim();
      const up = $('.i_unitprice', el).value.trim();
      return {
        raw_name: orig.raw_name || name,
        product_name: name,
        total_cents: parseEuro($('.i_total', el).value),
        category: $('.i_cat', el).value,
        quantity: parseNum($('.i_qty', el).value) || 1,
        unit: $('.i_unit', el).value,
        unit_price_cents: up ? parseEuro(up) : null,
        brand_type: $('.i_brand', el).value,
      };
    }),
  };
}

/* ================= Belege ================= */
async function receiptsView() {
  loading();
  const { receipts } = await api(`/api/receipts?month=${state.month}`);
  view.innerHTML = '';
  view.appendChild(monthNav(receiptsView));
  const sum = receipts.reduce((a, r) => a + r.total_cents, 0);
  view.insertAdjacentHTML('beforeend', receipts.length ? `
    <div class="card">
      <div class="row between"><span class="muted">${receipts.length} Belege</span><b class="num">${eur(sum)}</b></div>
      <ul class="list">${receipts.map((r) => `
        <li><a href="#/beleg/${r.id}" class="row between">
          <div class="grow"><b>${esc(r.store)}</b><div class="muted small">${dateDE(r.purchase_date)}${r.purchase_time ? ' · ' + esc(r.purchase_time) : ''} · ${r.item_count} Pos.</div></div>
          <span class="num">${eur(r.total_cents)}</span><span class="muted">›</span></a></li>`).join('')}
      </ul>
    </div>` : `<div class="card empty">Keine Belege in diesem Monat.</div>`);
}

async function receiptDetail(id) {
  loading();
  const r = await api(`/api/receipts/${id}`);
  const sum = r.items.reduce((a, it) => a + it.total_cents, 0);
  view.innerHTML = `
    <p><a class="link" href="#/belege">‹ Belege</a></p>
    <div class="card">
      <div class="row between"><div><h2 style="margin:0">${esc(r.store)}</h2>
        <div class="muted small">${dateDE(r.purchase_date)}${r.purchase_time ? ' · ' + esc(r.purchase_time) : ''} · ${esc(r.store_category)}</div></div>
        <div style="font-size:24px;font-weight:700" class="num">${eur(r.total_cents)}</div></div>
      ${Math.abs(sum - r.total_cents) > 1 ? `<div class="notice">Positionen ergeben ${eur(sum)}.</div>` : ''}
    </div>
    <div class="card"><ul class="list">${r.items.map((it) => `
      <li><a class="row between" href="#/produkt/${encodeURIComponent(it.product_name)}">
        <div class="grow"><div class="ellipsis">${esc(it.product_name)}</div>
          <div class="muted small">${esc(it.category)}${it.quantity !== 1 ? ` · ${String(it.quantity).replace('.', ',')} ${esc(it.unit)}` : ''}${it.unit_price_cents != null && it.quantity !== 1 ? ` à ${eur(it.unit_price_cents)}` : ''}</div></div>
        <span class="num">${eur(it.total_cents)}</span></a></li>`).join('')}</ul></div>
    <button class="btn" id="edit">Bearbeiten</button>
    <button class="btn danger" id="del">Beleg löschen</button>`;
  $('#edit').onclick = () => { location.hash = `#/beleg/${id}/bearbeiten`; };
  $('#del').onclick = async () => {
    if (!confirm('Diesen Beleg endgültig löschen?')) return;
    await api(`/api/receipts/${id}`, { method: 'DELETE' });
    toast('Beleg gelöscht'); location.hash = '#/belege';
  };
}

async function receiptEdit(id) {
  if (!state.draft || state.draftInfo?.editId !== Number(id)) {
    loading();
    state.draft = await api(`/api/receipts/${id}`);
    state.draftInfo = { editId: Number(id), duplicateOf: null };
  }
  reviewView();
}

/* ================= Produkte ================= */
async function productsView() {
  loading();
  const p = await api(`/api/products?days=${state.days}&today=${todayISO()}`);
  state.productsCache = p;
  view.innerHTML = `
    <h1>Produkte</h1>
    <div class="seg" id="range">${[30, 90, 365].map((d) => `<button data-d="${d}" class="${d === state.days ? 'on' : ''}">${d === 365 ? '1 Jahr' : d + ' Tage'}</button>`).join('')}</div>

    <div class="card">
      <h2>Sparpotenzial</h2>
      ${p.savings.length ? `
        <p style="margin-top:0"><b class="num" style="font-size:22px">${eur(p.totalSaving)}</b> <span class="muted">im Zeitraum</span><br>
        <span class="muted small">hochgerechnet ≈ ${eur(p.totalSavingPerYear)} pro Jahr – wenn du diese Produkte immer im günstigsten Geschäft kaufst.</span></p>
        <ul class="list">${p.savings.map((s) => {
          const other = s.stores[s.stores.length - 1];
          return `<li><a class="row between" href="#/produkt/${encodeURIComponent(s.name)}">
            <div class="grow"><div class="ellipsis">${esc(s.name)}</div>
            <div class="muted small">bei <b>${esc(s.bestStore)}</b> Ø ${eur(s.stores[0].avg)} statt ${eur(other.avg)} (${esc(other.store)})</div></div>
            <span class="chip good num">−${eur(s.saving)}</span></a></li>`;
        }).join('')}</ul>` : `<p class="muted" style="margin:0">Noch kein Sparpotenzial erkennbar. Es entsteht, sobald du dasselbe Produkt in verschiedenen Geschäften gekauft hast.</p>`}
    </div>

    <div class="card">
      <input id="search" type="search" placeholder="Produkt suchen …">
      <ul class="list" id="plist"></ul>
    </div>`;

  $$('#range button').forEach((b) => b.onclick = () => { state.days = Number(b.dataset.d); productsView(); });
  const renderList = (q = '') => {
    const rows = p.products.filter((x) => x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
    $('#plist').innerHTML = rows.length ? rows.map((x) => `
      <li><a class="row between" href="#/produkt/${encodeURIComponent(x.name)}">
        <div class="grow"><div class="ellipsis">${esc(x.name)}</div>
          <div class="muted small">${x.purchases}× · Ø ${eur(x.avgPrice)}${unitLabel(x.unit)}${x.priceChangePct ? ` · <span class="${x.priceChangePct > 0 ? 'delta-up' : 'delta-down'}">${x.priceChangePct > 0 ? '+' : ''}${x.priceChangePct} %</span>` : ''}</div></div>
        <span class="num">${eur(x.sum)}</span></a></li>`).join('') : '<li class="muted">Keine Produkte gefunden.</li>';
  };
  $('#search').addEventListener('input', (e) => renderList(e.target.value));
  renderList();
}

async function productDetail(name) {
  loading();
  const d = await api(`/api/product?name=${encodeURIComponent(name)}`);
  const p = state.productsCache?.products.find((x) => x.name === name);
  view.innerHTML = `
    <p><a class="link" href="javascript:history.back()">‹ Zurück</a></p>
    <h1 style="font-size:24px">${esc(name)}</h1>
    ${p ? `
    <div class="card">
      <div class="kpis" style="margin-top:0">
        <div class="kpi"><span>Ausgaben (${state.productsCache.days} T.)</span><b class="num">${eur(p.sum)}</b></div>
        <div class="kpi"><span>Käufe</span><b class="num">${p.purchases}×</b></div>
        <div class="kpi"><span>Ø Preis</span><b class="num">${eur(p.avgPrice)}${unitLabel(p.unit)}</b></div>
        <div class="kpi"><span>Spanne</span><b class="num small">${eur(p.minPrice)} – ${eur(p.maxPrice)}</b></div>
      </div>
      ${p.stores.length > 1 ? `<h2 style="margin-top:16px">Preis je Geschäft</h2>${hbars(p.stores, 'store', 'avg', 0)}` : ''}
    </div>` : ''}
    <div class="card"><h2>Verlauf</h2><ul class="list">${d.history.map((h) => `
      <li><a class="row between" href="#/beleg/${h.receipt_id}">
        <div class="grow">${dateDE(h.purchase_date)} · ${esc(h.store)}
          <div class="muted small">${String(h.quantity).replace('.', ',')} ${esc(h.unit)}${h.unit_price_cents != null ? ` à ${eur(h.unit_price_cents)}` : ''}</div></div>
        <span class="num">${eur(h.total_cents)}</span></a></li>`).join('')}</ul></div>`;
}

/* ================= Mehr / Einstellungen ================= */
// Datei an iOS übergeben: Teilen-Menü (Dateien sichern, AirDrop, Mail …), sonst Download
async function shareFile(content, name, type) {
  const file = new File([content], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function moreView() {
  const key = (await DB.setting('geminiKey')) || '';
  const model = (await DB.setting('geminiModel')) || GEMINI_DEFAULT_MODEL;
  const lastBackup = await DB.setting('lastBackup');
  const count = (await DB.getAll('receipts')).length;
  view.innerHTML = `
    <h1>Mehr</h1>
    <form class="card" id="keyForm">
      <h2>Bon-Erkennung (Google Gemini, kostenlos)</h2>
      <p class="muted small" style="margin-top:0">Schlüssel erstellen unter <b>aistudio.google.com/apikey</b> (Google-Konto nötig, keine Kreditkarte). Er wird nur auf diesem iPhone gespeichert.</p>
      <label for="k">API-Schlüssel</label>
      <input id="k" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Schlüssel hier einfügen" value="${esc(key)}">
      <details style="margin-top:8px"><summary class="small muted">Erweitert: Modell</summary>
        <label for="mdl">Gemini-Modell</label>
        <input id="mdl" autocapitalize="off" spellcheck="false" value="${esc(model)}">
        <p class="muted small">Standard: ${GEMINI_DEFAULT_MODEL}. Nur ändern, wenn Google das Modell einstellt.</p>
      </details>
      <button class="btn primary" style="margin-top:12px">Speichern</button>
    </form>

    <div class="card">
      <h2>Datensicherung</h2>
      <p class="muted small" style="margin-top:0">Deine ${count} Belege liegen <b>nur auf diesem iPhone</b>. Sichere sie regelmäßig (z. B. monatlich) in der Dateien-App oder iCloud Drive.
      ${lastBackup ? `Letzte Sicherung: ${dateDE(lastBackup.slice(0, 10))}.` : '<b>Noch keine Sicherung erstellt.</b>'}</p>
      <button class="btn primary" id="backup">Sicherung erstellen</button>
      <button class="btn" id="restore">Sicherung wiederherstellen</button>
      <button class="btn" id="csv">Als CSV exportieren (Excel/Numbers)</button>
      <input type="file" id="restoreFile" accept="application/json,.json" class="hidden">
    </div>

    <div class="card">
      <h2>Tipps für gute Scans</h2>
      <ul class="small muted" style="padding-left:18px;margin:0">
        <li>Bon glatt streichen, auf dunklen Untergrund legen.</li>
        <li>Von oben fotografieren, ohne Schatten.</li>
        <li>Lange Bons in 2–4 Teilen fotografieren (mit etwas Überlappung).</li>
        <li>Korrigierte Produktnamen merkt sich die App für künftige Scans.</li>
      </ul>
    </div>
    <p class="muted small" style="text-align:center">BelegCheck 2.0 · lokal &amp; kostenlos</p>`;

  $('#keyForm').onsubmit = async (ev) => {
    ev.preventDefault();
    await DB.setting('geminiKey', $('#k').value.trim());
    await DB.setting('geminiModel', $('#mdl').value.trim() || GEMINI_DEFAULT_MODEL);
    state.hasKey = !!$('#k').value.trim();
    toast('Gespeichert ✓');
  };
  $('#backup').onclick = async () => {
    await shareFile(await buildBackup(), `belegcheck-sicherung-${todayISO()}.json`, 'application/json');
    await DB.setting('lastBackup', new Date().toISOString());
  };
  $('#csv').onclick = async () => shareFile(await buildCsv(), `belegcheck-${todayISO()}.csv`, 'text/csv');
  $('#restore').onclick = () => $('#restoreFile').click();
  $('#restoreFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f || !confirm('Alle aktuellen Daten durch die Sicherung ersetzen?')) return;
    try { toast(`${await restoreBackup(await f.text())} Belege wiederhergestellt ✓`); moreView(); }
    catch (err) { toast(err.message, 4000); }
  };
}

/* ================= Start ================= */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
