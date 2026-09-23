// Lokale Datenbank im iPhone (IndexedDB). Nichts verlässt das Gerät –
// außer den Bon-Fotos, die einmalig zur Erkennung an Gemini gesendet werden.
'use strict';

const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('belegcheck', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Beleg inkl. Positionen als ein Datensatz
        const r = db.createObjectStore('receipts', { keyPath: 'id', autoIncrement: true });
        r.createIndex('date', 'purchase_date');
        // Gelernte Korrekturen: Schlüssel "Geschäft|Bon-Text"
        db.createObjectStore('aliases', { keyPath: 'key' });
        // Einstellungen (API-Schlüssel, Modell)
        db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  return {
    getAll: (store) => tx(store, 'readonly', (s) => wrap(s.getAll())),
    get: (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key))),
    put: (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value))),
    putMany: (store, values) => tx(store, 'readwrite', (s) => Promise.all(values.map((v) => wrap(s.put(v))))),
    del: (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key))),
    clear: (store) => tx(store, 'readwrite', (s) => wrap(s.clear())),
    async setting(key, value) {
      if (value === undefined) return (await this.get('settings', key))?.value;
      return this.put('settings', { key, value });
    },
  };
})();

// iOS bitten, die Daten dauerhaft zu behalten (nicht bei Speicherknappheit löschen)
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
