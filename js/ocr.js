// PP-OCRv5 Mobile text recognition (ONNX, onnxruntime-web). No network, no server.
// The model's classifier is trimmed to digit-relevant classes (see tools/trim_model.py);
// every kept logit is identical to the original network's.
const MAP = { l: '1', I: '1', '|': '1', '/': '1', '一': '-', '—': '-', '–': '-', '_': '-', '.': '' };
const BUCKETS = [48, 96, 160, 256];

export class Recognizer {
  static async create(ort, { modelUrl, labels, backend = 'wasm', threads }) {
    const r = new Recognizer();
    r.ort = ort; r.labels = labels; r.backend = backend;
    if (backend === 'wasm') {
      ort.env.wasm.numThreads = threads ?? Math.min(4, (globalThis.navigator?.hardwareConcurrency || 2));
      ort.env.wasm.simd = true;
    }
    const t = performance.now();
    r.session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
    });
    r.loadMs = performance.now() - t;
    r.input = r.session.inputNames[0]; r.output = r.session.outputNames[0];
    return r;
  }

  /** Warm every bucket shape so the first real capture is not slowed by compilation. */
  async warmup(sizes = [[16, 48], [8, 96]]) {
    const t = performance.now();
    for (const [n, w] of sizes) {
      const x = new this.ort.Tensor('float32', new Float32Array(n * 3 * 48 * w), [n, 3, 48, w]);
      await this.session.run({ [this.input]: x });
    }
    return performance.now() - t;
  }

  /** crops: array of {w,h,rgba}|null → array of results|null */
  async recognize(crops, stretch = this.stretch ?? 1) {
    const groups = new Map();
    crops.forEach((c, i) => {
      if (!c) return;
      const tw = Math.max(32, Math.round(48 * c.w / c.h * stretch));
      const b = BUCKETS.find(x => tw <= x) ?? BUCKETS[BUCKETS.length - 1];
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push({ i, c, tw: Math.min(tw, b) });
    });
    const res = new Array(crops.length).fill(null);
    for (const [bw, items] of groups) {
      const n = items.length, data = new Float32Array(n * 3 * 48 * bw); // 0 = PaddleOCR padding value
      items.forEach((it, k) => fill(data, k, it.c, it.tw, bw));
      const x = new this.ort.Tensor('float32', data, [n, 3, 48, bw]);
      const out = (await this.session.run({ [this.input]: x }))[this.output];
      const [, Tn, C] = out.dims, P = out.data;
      items.forEach((it, k) => { res[it.i] = decode(P, k * Tn * C, Tn, C, this.labels); });
    }
    return res;
  }
}

// area-average resize into the tensor (BGR order, (x/255-0.5)/0.5 like PaddleOCR)
function fill(data, k, c, tw, bw) {
  const plane = 48 * bw, base = k * 3 * plane, sx = c.w / tw, sy = c.h / 48;
  for (let y = 0; y < 48; y++) {
    const ya = y * sy, yb = Math.min(c.h, (y + 1) * sy);
    for (let x = 0; x < tw; x++) {
      const xa = x * sx, xb = Math.min(c.w, (x + 1) * sx);
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) {
        const wy = Math.min(yy + 1, yb) - Math.max(yy, ya);
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) {
          const wx = Math.min(xx + 1, xb) - Math.max(xx, xa), w = wx * wy, i = (yy * c.w + xx) * 4;
          r += c.rgba[i] * w; g += c.rgba[i + 1] * w; b += c.rgba[i + 2] * w; wsum += w;
        }
      }
      const o = base + y * bw + x;
      data[o] = (b / wsum / 255 - 0.5) / 0.5;            // B
      data[o + plane] = (g / wsum / 255 - 0.5) / 0.5;    // G
      data[o + 2 * plane] = (r / wsum / 255 - 0.5) / 0.5;// R
    }
  }
}

// greedy CTC with per-character alternatives
export function decode(P, off, Tn, C, labels) {
  const chars = []; let prev = 0;
  for (let t = 0; t < Tn; t++) {
    const o = off + t * C; let bi = 0, bp = -1;
    for (let c = 0; c < C; c++) if (P[o + c] > bp) { bp = P[o + c]; bi = c; }
    if (bi !== 0 && bi !== prev) {
      // second best non-blank that maps to a different text
      const main = MAP[labels[bi]] ?? labels[bi];
      const alts = {};
      for (let c = 1; c < C; c++) { const m = MAP[labels[c]] ?? labels[c]; if (m !== main) alts[m] = Math.max(alts[m] || 0, P[o + c]); }
      chars.push({ ch: main, p: bp, alts, t });
    } else if (bi !== 0 && bi === prev && chars.length) {
      chars[chars.length - 1].p = Math.max(chars[chars.length - 1].p, bp);
    }
    prev = bi;
  }
  const kept = chars.filter(c => c.ch !== '');
  const text = kept.map(c => c.ch).join('');
  const conf = kept.length ? Math.min(...kept.map(c => c.p)) : 0;
  const base = kept.reduce((s, c) => s * c.p, 1);
  const cands = new Map([[text, base]]);
  kept.forEach((c, i) => {
    for (const [a, p] of Object.entries(c.alts)) {
      if (p < 0.02) continue;
      const tx = kept.map((d, j) => j === i ? a : d.ch).join('');
      const sc = base / c.p * p;
      if (sc > (cands.get(tx) || 0)) cands.set(tx, sc);
    }
  });
  // single-character view: best probability of each digit anywhere in time
  const digitMax = {};
  for (let t = 0; t < Tn; t++) for (let c = 1; c < C; c++) {
    const m = MAP[labels[c]] ?? labels[c]; if (!/^\d$/.test(m)) continue;
    const p = P[off + t * C + c]; if (p > (digitMax[m] || 0)) digitMax[m] = p;
  }
  if (kept.length <= 1) for (const [d, p] of Object.entries(digitMax)) {
    const sc = p * (kept.length ? base / Math.max(kept[0].p, 1e-6) : 1) * 0.9;
    if (p > 0.03 && sc > (cands.get(d) || 0)) cands.set(d, sc);
  }
  if (!kept.length) cands.delete('');
  const tot = [...cands.values()].reduce((a, b) => a + b, 0) || 1;
  const alts = [...cands.entries()].map(([t, p]) => ({ text: t, p: p / tot })).sort((a, b) => b.p - a.p).slice(0, 5);
  return { text, conf, alts };
}
