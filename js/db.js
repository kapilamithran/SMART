// IndexedDB persistence: batches, records, scan images, metrics, settings. Everything stays on the phone.
const NAME = 'rec-booklet-scanner', VERSION = 1;
let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('batches', { keyPath: 'id' });
      const rs = d.createObjectStore('records', { keyPath: 'id' });
      rs.createIndex('batchId', 'batchId');
      d.createObjectStore('images', { keyPath: 'id' });
      const m = d.createObjectStore('metrics', { keyPath: 'id', autoIncrement: true });
      m.createIndex('type', 'type');
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const req = fn(s);
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
export const db = {
  put: (store, v) => tx(store, 'readwrite', s => s.put(v)),
  get: (store, k) => tx(store, 'readonly', s => s.get(k)),
  del: (store, k) => tx(store, 'readwrite', s => s.delete(k)),
  all: (store) => tx(store, 'readonly', s => s.getAll()),
  byIndex: (store, idx, v) => tx(store, 'readonly', s => s.index(idx).getAll(v)),
  async setting(key, def) { const r = await this.get('settings', key); return r ? r.value : def; },
  setSetting: (key, value) => tx('settings', 'readwrite', s => s.put({ key, value })),
  metric: (type, data) => tx('metrics', 'readwrite', s => s.add({ type, at: new Date().toISOString(), ...data })),
};
