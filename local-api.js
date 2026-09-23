// "API" komplett im iPhone: gleiche Endpunkte wie die Server-Version,
// aber Daten aus der lokalen Datenbank (db.js). Alle Beträge in Cent.
'use strict';

const EXCLUDED_CATS = ['Pfand', 'Rabatt'];

function _pad(n) { return String(n).padStart(2, '0'); }
function _shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}`;
}
function _daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function _isoDay(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return s;
  const d = new Date();
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
}
const _sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
function _groupSum(rows, keyFn, valFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + valFn(r)); }
  return m;
}

/* ---------- Validierung beim Speichern ---------- */
function cleanReceipt(r) {
  const s = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.purchase_date || '')) throw new Error('Datum fehlt oder ist ungültig');
  if (!s(r.store)) throw new Error('Geschäft fehlt');
  return {
    store: s(r.store, 60),
    store_category: STORE_CATEGORIES.includes(r.store_category) ? r.store_category : 'Sonstiges',
    purchase_date: r.purchase_date,
    purchase_time: s(r.purchase_time, 5) || null,
    total_cents: int(r.total_cents),
    note: s(r.note, 500) || null,
    items: (r.items || []).map((it, i) => ({
      position: i + 1,
      raw_name: s(it.raw_name) || s(it.product_name),
      product_name: s(it.product_name) || s(it.raw_name) || 'Unbekannt',
      category: ITEM_CATEGORIES.includes(it.category) ? it.category : 'Sonstiges',
      brand_type: ['marke', 'eigenmarke'].includes(it.brand_type) ? it.brand_type : 'unbekannt',
      quantity: Number(it.quantity) ? Number(it.quantity) : 1,
      unit: ['stk', 'kg', 'l'].includes(it.unit) ? it.unit : 'stk',
      unit_price_cents: it.unit_price_cents == null || it.unit_price_cents === '' ? null : int(it.unit_price_cents),
      total_cents: int(it.total_cents),
    })),
  };
}

async function saveReceipt(raw, id = null) {
  const r = cleanReceipt(raw);
  const existing = id ? await DB.get('receipts', id) : null;
  const rec = { ...r, created_at: existing?.created_at || new Date().toISOString() };
  if (id) rec.id = id;
  const newId = await DB.put('receipts', rec);
  // Lernen: bestätigte Zuordnung Bon-Text -> Produkt merken
  await DB.putMany('aliases', r.items.filter((it) => it.raw_name).map((it) => ({
    key: `${r.store}|${it.raw_name}`, product_name: it.product_name, category: it.category,
  })));
  return newId;
}

/* ---------- Scan ---------- */
async function scanReceipt(images, today) {
  const apiKey = await DB.setting('geminiKey');
  if (!apiKey) throw new Error('Bitte zuerst unter „Mehr“ deinen kostenlosen Gemini-API-Schlüssel eintragen.');
  const model = (await DB.setting('geminiModel')) || GEMINI_DEFAULT_MODEL;
  const all = await DB.getAll('receipts');

  // häufigste Produktnamen mitschicken -> einheitliche Benennung
  const counts = new Map();
  all.forEach((r) => r.items.forEach((it) => {
    if (!EXCLUDED_CATS.includes(it.category)) counts.set(it.product_name, (counts.get(it.product_name) || 0) + 1);
  }));
  const known = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map((e) => e[0]);

  const receipt = window.__MOCK_GEMINI
    ? await window.__MOCK_GEMINI()
    : await geminiExtract({ apiKey, model, images, knownProducts: known, today });
  if (receipt.lesbar === false) throw new Error('Der Beleg konnte nicht gelesen werden. Bitte näher, gerader und mit mehr Licht fotografieren.');

  // gelernte Korrekturen anwenden
  const aliases = new Map((await DB.getAll('aliases')).map((a) => [a.key, a]));
  receipt.items = (receipt.items || []).map((it) => {
    const a = aliases.get(`${receipt.store}|${it.raw_name}`);
    if (!a) return it;
    const changed = a.product_name !== it.product_name || a.category !== it.category;
    return { ...it, product_name: a.product_name, category: a.category, learned: changed };
  });

  const dup = all.find((r) => r.store === receipt.store && r.purchase_date === receipt.purchase_date && r.total_cents === receipt.total_cents);
  return { receipt, duplicateOf: dup ? dup.id : null };
}

/* ---------- Auswertungen ---------- */
async function local_summary(params) {
  const today = _isoDay(params.get('today'));
  const month = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : today.slice(0, 7);
  const prev = _shiftMonth(month, -1);
  const from6 = _shiftMonth(month, -5);
  const next = _shiftMonth(month, 1);

  const all = await DB.getAll('receipts');
  const inMonth = all.filter((r) => r.purchase_date.startsWith(month));
  const inPrev = all.filter((r) => r.purchase_date.startsWith(prev));
  const items = inMonth.flatMap((r) => r.items.map((it) => ({ ...it, store: r.store })));
  const prodItems = items.filter((it) => !EXCLUDED_CATS.includes(it.category));

  const monthSum = _sum(inMonth, (r) => r.total_cents);
  const dim = _daysInMonth(month);
  const isCurrent = today.startsWith(month);
  const daysElapsed = isCurrent ? Number(today.slice(8, 10)) : dim;
  const avgPerDay = daysElapsed ? Math.round(monthSum / daysElapsed) : 0;
  const cutoff = `${prev}-${_pad(Math.min(daysElapsed, _daysInMonth(prev)))}`;

  const toRows = (map, k, v = 'sum') => [...map.entries()].map(([a, b]) => ({ [k]: a, [v]: b })).sort((x, y) => y[v] - x[v]);

  // Top-Produkte
  const prodMap = new Map();
  for (const it of prodItems) {
    const p = prodMap.get(it.product_name) || { product_name: it.product_name, category: it.category, purchases: 0, qty: 0, unit: it.unit, sum: 0 };
    p.purchases++; p.qty += it.quantity; p.sum += it.total_cents;
    prodMap.set(it.product_name, p);
  }
  const storeMap = new Map();
  for (const r of inMonth) {
    const s = storeMap.get(r.store) || { store: r.store, visits: 0, sum: 0 };
    s.visits++; s.sum += r.total_cents; storeMap.set(r.store, s);
  }
  const trendRows = all.filter((r) => r.purchase_date >= from6 + '-01' && r.purchase_date < next + '-01');

  return {
    month, today,
    todaySum: _sum(all.filter((r) => r.purchase_date === today), (r) => r.total_cents),
    todayCount: all.filter((r) => r.purchase_date === today).length,
    monthSum,
    receiptCount: inMonth.length,
    prevMonth: prev,
    prevMonthSum: _sum(inPrev, (r) => r.total_cents),
    prevSameDaySum: isCurrent ? _sum(inPrev.filter((r) => r.purchase_date <= cutoff), (r) => r.total_cents) : null,
    avgPerDay,
    forecast: isCurrent ? avgPerDay * dim : null,
    daysInMonth: dim,
    byDay: toRows(_groupSum(inMonth, (r) => r.purchase_date, (r) => r.total_cents), 'day').sort((a, b) => a.day.localeCompare(b.day)),
    byCategory: toRows(_groupSum(items, (it) => it.category, (it) => it.total_cents), 'category'),
    topProducts: [...prodMap.values()].sort((a, b) => b.sum - a.sum).slice(0, 10),
    byStore: [...storeMap.values()].sort((a, b) => b.sum - a.sum),
    brandSplit: toRows(_groupSum(prodItems, (it) => it.brand_type, (it) => it.total_cents), 'brand_type'),
    trend: toRows(_groupSum(trendRows, (r) => r.purchase_date.slice(0, 7), (r) => r.total_cents), 'month').sort((a, b) => a.month.localeCompare(b.month)),
  };
}

// Produktübersicht inkl. Sparpotenzial durch günstigeres Geschäft
async function local_products(params) {
  const today = _isoDay(params.get('today'));
  const days = Math.min(Math.max(Number(params.get('days')) || 90, 7), 730);
  const from = new Date(Date.parse(today) - days * 86400000).toISOString().slice(0, 10);

  const rows = (await DB.getAll('receipts'))
    .filter((r) => r.purchase_date >= from)
    .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))
    .flatMap((r) => r.items
      .filter((it) => !EXCLUDED_CATS.includes(it.category) && it.total_cents > 0)
      .map((it) => ({ ...it, store: r.store, purchase_date: r.purchase_date })));

  const map = new Map();
  for (const row of rows) {
    let p = map.get(row.product_name);
    if (!p) {
      p = { name: row.product_name, category: row.category, brand_type: row.brand_type, unit: row.unit, purchases: 0, qty: 0, sum: 0, prices: [], stores: new Map() };
      map.set(row.product_name, p);
    }
    const qty = row.quantity > 0 ? row.quantity : 1;
    p.purchases++; p.qty += qty; p.sum += row.total_cents;
    p.prices.push({ price: row.total_cents / qty, qty });
    const s = p.stores.get(row.store) || { qty: 0, sum: 0 };
    s.qty += qty; s.sum += row.total_cents; p.stores.set(row.store, s);
  }

  const list = [];
  let totalSaving = 0;
  for (const p of map.values()) {
    const unitPrices = p.prices.map((x) => x.price);
    const storeAvgs = [...p.stores.entries()].map(([store, s]) => ({ store, avg: s.sum / s.qty })).sort((a, b) => a.avg - b.avg);
    let saving = 0, bestStore = null;
    if (storeAvgs.length >= 2) {
      bestStore = storeAvgs[0];
      saving = p.prices.reduce((acc, x) => acc + Math.max(0, x.price - bestStore.avg) * x.qty, 0);
    }
    const first = p.prices[0].price, last = p.prices[p.prices.length - 1].price;
    totalSaving += saving;
    list.push({
      name: p.name, category: p.category, brand_type: p.brand_type, unit: p.unit,
      purchases: p.purchases, qty: Math.round(p.qty * 100) / 100, sum: p.sum,
      avgPrice: Math.round(p.sum / p.qty),
      minPrice: Math.round(Math.min(...unitPrices)), maxPrice: Math.round(Math.max(...unitPrices)),
      lastPrice: Math.round(last),
      priceChangePct: p.prices.length >= 2 && first > 0 ? Math.round(((last - first) / first) * 100) : null,
      stores: storeAvgs.map((s) => ({ store: s.store, avg: Math.round(s.avg) })),
      bestStore: bestStore ? bestStore.store : null,
      saving: Math.round(saving),
    });
  }
  list.sort((a, b) => b.sum - a.sum);

  // Jahreshochrechnung auf Basis des tatsächlich erfassten Zeitraums (mind. 30 Tage)
  const firstDate = rows.length ? rows[0].purchase_date : today;
  const spanDays = Math.min(days, Math.max(30, Math.round((Date.parse(today) - Date.parse(firstDate)) / 86400000) + 1));
  return {
    days, from, products: list,
    savings: list.filter((p) => p.saving > 0).sort((a, b) => b.saving - a.saving).slice(0, 15),
    totalSaving: Math.round(totalSaving),
    totalSavingPerYear: Math.round((totalSaving * 365) / spanDays),
    spanDays,
  };
}

async function local_productDetail(params) {
  const name = params.get('name') || '';
  const history = (await DB.getAll('receipts'))
    .flatMap((r) => r.items.filter((it) => it.product_name === name).map((it) => ({
      purchase_date: r.purchase_date, store: r.store, quantity: it.quantity, unit: it.unit,
      unit_price_cents: it.unit_price_cents, total_cents: it.total_cents, raw_name: it.raw_name, receipt_id: r.id,
    })))
    .sort((a, b) => b.purchase_date.localeCompare(a.purchase_date));
  return { name, history };
}

/* ---------- Einheitlicher Einstieg (gleiche Pfade wie Server-Version) ---------- */
async function api(path, opts = {}) {
  const url = new URL(path, 'https://local');
  const p = url.pathname;
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;

  if (p === '/api/me') return { ok: true, categories: ITEM_CATEGORIES, storeCategories: STORE_CATEGORIES };
  if (p === '/api/scan') return scanReceipt(body.images, _isoDay());
  if (p === '/api/receipts' && method === 'GET') {
    const month = url.searchParams.get('month');
    const receipts = (await DB.getAll('receipts'))
      .filter((r) => r.purchase_date.startsWith(month))
      .map((r) => ({ ...r, item_count: r.items.length }))
      .sort((a, b) => (b.purchase_date + (b.purchase_time || '') + String(b.id).padStart(8, '0'))
        .localeCompare(a.purchase_date + (a.purchase_time || '') + String(a.id).padStart(8, '0')));
    return { receipts };
  }
  if (p === '/api/receipts' && method === 'POST') return { id: await saveReceipt(body) };
  const m = p.match(/^\/api\/receipts\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const r = await DB.get('receipts', id);
      if (!r) throw new Error('Beleg nicht gefunden');
      return r;
    }
    if (method === 'PUT') return { id: await saveReceipt(body, id) };
    if (method === 'DELETE') { await DB.del('receipts', id); return { ok: true }; }
  }
  if (p === '/api/summary') return local_summary(url.searchParams);
  if (p === '/api/products') return local_products(url.searchParams);
  if (p === '/api/product') return local_productDetail(url.searchParams);
  throw new Error('Unbekannte Funktion');
}

/* ---------- Export / Sicherung ---------- */
async function buildCsv() {
  const all = (await DB.getAll('receipts')).sort((a, b) => a.purchase_date.localeCompare(b.purchase_date) || a.id - b.id);
  const head = ['Datum', 'Uhrzeit', 'Geschäft', 'Geschäftsart', 'Produkt', 'Bon-Text', 'Kategorie', 'Markentyp', 'Menge', 'Einheit', 'Einzelpreis', 'Betrag', 'Beleg-ID'];
  const euro = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(';')];
  for (const r of all) for (const x of r.items) {
    lines.push([r.purchase_date, r.purchase_time, r.store, r.store_category, x.product_name, x.raw_name, x.category,
      x.brand_type, String(x.quantity).replace('.', ','), x.unit, euro(x.unit_price_cents), euro(x.total_cents), r.id].map(esc).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

async function buildBackup() {
  return JSON.stringify({
    app: 'belegcheck', version: 1, exported_at: new Date().toISOString(),
    receipts: await DB.getAll('receipts'),
    aliases: await DB.getAll('aliases'),
  });
}

async function restoreBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Datei ist keine gültige Sicherung.'); }
  if (data.app !== 'belegcheck' || !Array.isArray(data.receipts)) throw new Error('Datei ist keine BelegCheck-Sicherung.');
  await DB.clear('receipts');
  await DB.clear('aliases');
  await DB.putMany('receipts', data.receipts);
  await DB.putMany('aliases', data.aliases || []);
  return data.receipts.length;
}
