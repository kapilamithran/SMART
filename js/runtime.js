// Loads OpenCV.js, onnxruntime-web and the bundled PP-OCRv5 Mobile model. No remote URLs.
import { Pipeline } from './pipeline.js';
import { Recognizer } from './ocr.js';

const BASE = new URL('../', import.meta.url).href;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src)); document.head.appendChild(s);
  });
}

export async function loadOpenCV() {
  if (!globalThis.cv || !globalThis.cv.Mat) await loadScript(BASE + 'vendor/opencv/opencv.js');
  let cv = globalThis.cv;
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat) cv = await new Promise(r => { cv.onRuntimeInitialized = () => r(cv); });
  globalThis.cv = cv;
  return cv;
}

/** WebGPU needs a GPU and the optional 28 MB jsep runtime (may be left out of the deploy). */
export async function webgpuAvailable() {
  if (!navigator.gpu) return false;
  try { return (await fetch(BASE + 'vendor/ort/ort-wasm-simd-threaded.jsep.wasm', { method: 'HEAD' })).ok; } catch { return false; }
}

export async function loadOrt(backend = 'wasm') {
  const file = backend === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs';
  const ort = await import(BASE + 'vendor/ort/' + file);
  ort.env.wasm.wasmPaths = BASE + 'vendor/ort/';
  return ort;
}

/**
 * Boot everything and measure cold-load parts (ms since navigation start).
 * settings: { backend: 'wasm'|'webgpu', threads, proxy }
 */
export async function boot(settings = {}, onStep = () => {}) {
  const t0 = performance.now();
  const parts = {};
  onStep('Loading vision runtime…');
  const cvP = loadOpenCV().then(cv => { parts.opencv = performance.now() - t0; return cv; });
  onStep('Loading OCR runtime…');
  let backend = settings.backend || 'wasm';
  if (backend === 'webgpu' && !(await webgpuAvailable())) backend = 'wasm';
  const ort = await loadOrt(backend);
  parts.ortModule = performance.now() - t0;
  const iso = globalThis.crossOriginIsolated === true;
  const threads = iso ? (settings.threads || Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
  ort.env.wasm.proxy = settings.proxy !== false && backend === 'wasm';
  const labels = (await (await fetch(BASE + 'models/ppocrv5_mobile_rec_digits.labels.json')).json()).labels;
  onStep('Loading PP-OCRv5 Mobile model…');
  let rec;
  try {
    rec = await Recognizer.create(ort, { modelUrl: BASE + 'models/ppocrv5_mobile_rec_digits.onnx', labels, backend, threads });
  } catch (e) {
    // proxy worker or WebGPU unavailable → plain in-thread WASM
    console.warn('falling back to in-thread wasm', e);
    ort.env.wasm.proxy = false;
    rec = await Recognizer.create(ort, { modelUrl: BASE + 'models/ppocrv5_mobile_rec_digits.onnx', labels, backend: 'wasm', threads });
    backend = 'wasm';
  }
  parts.model = performance.now() - t0;
  onStep('Warming up…');
  const cv = await cvP;
  const warm = await rec.warmup();
  parts.warmup = warm;
  const pipe = new Pipeline(cv);
  const ready = performance.now();
  return {
    cv, ort, rec, pipe,
    info: {
      backend, threads, proxy: !!ort.env.wasm.proxy, crossOriginIsolated: iso,
      coldLoadMs: Math.round(ready),              // since navigation start
      bootMs: Math.round(ready - t0),
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
      swControlled: !!navigator.serviceWorker?.controller,
      ua: navigator.userAgent, brave: !!navigator.brave,
      cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
    },
  };
}
