// Offline cache + cross-origin isolation headers. Bump VERSION on every deploy.
const VERSION = 'smart-v2.0.0';
const CORE = [
  './', 'index.html', 'bench.html', 'css/smart.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/coi.js', 'js/app.js', 'js/bench.js', 'js/camera.js', 'js/db.js', 'js/export.js', 'js/ocr.js', 'js/pipeline.js',
  'js/rules.js', 'js/runtime.js', 'js/scan.js', 'js/template.js',
  'vendor/opencv/opencv.js', 'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm',
  'vendor/jspdf/jspdf.umd.min.js', 'vendor/jszip/jszip.min.js',
  'models/ppocrv5_mobile_rec_digits.onnx', 'models/ppocrv5_mobile_rec_digits.labels.json',
];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
function isolate(resp) {
  if (!resp || resp.status === 0 || resp.type === 'opaque') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return isolate(hit);
    try {
      const resp = await fetch(req);
      if (resp.ok && !req.url.includes('/tests/')) cache.put(req, resp.clone()); // also caches the optional WebGPU runtime when first used
      return isolate(resp);
    } catch (err) {
      if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return isolate(idx); }
      throw err;
    }
  })());
});
