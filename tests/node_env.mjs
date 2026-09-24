// Node harness: same modules as the browser, OpenCV.js + onnxruntime-web (wasm).
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const DEP = process.env.DEP || new URL('./node_modules/', import.meta.url).pathname;
export async function loadCv() {
  const m = require(DEP + '@techstark/opencv-js');
  return (m instanceof Promise) ? await m : await new Promise(r => { if (m.Mat) r(m); else m.onRuntimeInitialized = () => r(m); });
}
export async function loadOrt() { return await import(DEP + 'onnxruntime-web/dist/ort.node.min.mjs').catch(() => import(DEP + 'onnxruntime-web/dist/ort.wasm.min.mjs')); }
export function readImage(cv, path) {
  const buf = fs.readFileSync(path);
  let img;
  if (path.endsWith('.png')) { const { PNG } = require(DEP + 'pngjs'); const p = PNG.sync.read(buf); img = { data: p.data, width: p.width, height: p.height }; }
  else { const jpeg = require(DEP + 'jpeg-js'); img = jpeg.decode(buf, { useTArray: true }); }
  const m = new cv.Mat(img.height, img.width, cv.CV_8UC4); m.data.set(img.data); return m;
}
