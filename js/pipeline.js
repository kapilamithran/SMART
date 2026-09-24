// Vision pipeline (OpenCV.js). Runs identically in the browser and in Node (tests/bench).
import { TEMPLATE as T, PART_A, PART_B } from './template.js';

const odd = n => (n | 1);

// ---------- small 3x3 matrix helpers ----------
function matMul(a, b) { const r = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]; return r; }
function apply(Hm, x, y) { const w = Hm[6] * x + Hm[7] * y + Hm[8]; return [(Hm[0] * x + Hm[1] * y + Hm[2]) / w, (Hm[3] * x + Hm[4] * y + Hm[5]) / w]; }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function orderQuad(pts) {
  // TL, TR, BR, BL for a roughly upright quad
  const s = pts.map(p => p[0] + p[1]), d = pts.map(p => p[0] - p[1]);
  const tl = pts[s.indexOf(Math.min(...s))], br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.max(...d))], bl = pts[d.indexOf(Math.min(...d))];
  return [tl, tr, br, bl];
}

function peaks(proj, thr, gap = 3) {
  const out = []; let run = null;
  for (let i = 0; i < proj.length; i++) {
    if (proj[i] > thr) {
      if (run && i - run.end <= gap) { run.end = i; run.sw += proj[i]; run.sx += proj[i] * i; }
      else { run = { start: i, end: i, sw: proj[i], sx: proj[i] * i }; out.push(run); }
    }
  }
  return out.map(r => r.sx / r.sw);
}
function snap(template, found, tol) {
  return template.map(t => { let best = null, bd = tol; for (const f of found) { const dd = Math.abs(f - t); if (dd < bd) { bd = dd; best = f; } } return best ?? t; });
}

export class Pipeline {
  constructor(cv, opts = {}) { this.cv = cv; this.tableScale = opts.tableScale ?? 0.75; this.regScale = opts.regScale ?? 1.0; this.boxScale = opts.boxScale ?? 0.7; }

  // ---------- helpers ----------
  maxMin(rgba) {
    const cv = this.cv, mv = new cv.MatVector(); cv.split(rgba, mv);
    const mx = new cv.Mat(), mn = new cv.Mat();
    cv.max(mv.get(0), mv.get(1), mx); cv.max(mx, mv.get(2), mx);
    cv.min(mv.get(0), mv.get(1), mn); cv.min(mn, mv.get(2), mn);
    for (let i = 0; i < mv.size(); i++) mv.get(i).delete(); mv.delete();
    return [mx, mn];
  }
  lineMasks(gray, hLen, vLen, block = 25, C = 8) {
    const cv = this.cv, bw = new cv.Mat(), h = new cv.Mat(), v = new cv.Mat();
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, odd(block), C);
    let k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, hLen | 0), 1));
    cv.morphologyEx(bw, h, cv.MORPH_OPEN, k); k.delete();
        k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(5, vLen | 0)));
    cv.morphologyEx(bw, v, cv.MORPH_OPEN, k); k.delete();
    bw.delete();
    return [h, v];
  }
  homography(quad) {
    const cv = this.cv, { w, h } = T.table;
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
    const m = cv.getPerspectiveTransform(a, b);
    const H = Array.from(m.data64F); a.delete(); b.delete(); m.delete();
    return H; // canonical -> image
  }
  /** Warp canonical rect [x0,y0,x1,y1] at S px/unit from src using H (canonical->image). */
  warp(src, H, rect, S = 1) {
    const cv = this.cv, [x0, y0, x1, y1] = rect;
    const Tinv = [1 / S, 0, x0, 0, 1 / S, y0, 0, 0, 1]; // output px -> canonical
    const M = matMul(H, Tinv); // output px -> image
    const m = cv.matFromArray(3, 3, cv.CV_64F, M), dst = new cv.Mat();
    cv.warpPerspective(src, dst, m, new cv.Size(Math.round((x1 - x0) * S), Math.round((y1 - y0) * S)),
      cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
    m.delete();
    return dst;
  }

  // ---------- form detection (live + capture) ----------
  /** src: RGBA Mat. Returns {quad (src coords), score, sidesRatio} or null. */
  detect(src, maxSide = 800) {
    const cv = this.cv, del = [];
    try {
      const sc = Math.min(1, maxSide / Math.max(src.cols, src.rows));
      let small = src;
      if (sc < 1) { small = new cv.Mat(); del.push(small); cv.resize(src, small, new cv.Size(Math.round(src.cols * sc), Math.round(src.rows * sc)), 0, 0, cv.INTER_AREA); }
      const W = small.cols, Hh = small.rows, ms = Math.max(W, Hh);
      const [mx, mn] = this.maxMin(small); del.push(mx, mn);
      const [h, v] = this.lineMasks(mx, ms / 45, ms / 100, ms / 40, 10); del.push(h, v);
      const grid = new cv.Mat(); del.push(grid); cv.bitwise_or(h, v, grid);
      const cs = new cv.MatVector(), hier = new cv.Mat(); del.push(cs, hier);
      cv.findContours(grid, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = null;
      for (let i = 0; i < cs.size(); i++) {
        const c = cs.get(i); const area = cv.contourArea(c);
        if (area < 0.004 * W * Hh) { c.delete(); continue; }
        const hull = new cv.Mat(); cv.convexHull(c, hull);
        const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, 0.025 * cv.arcLength(hull, true), true);
        let pts;
        if (ap.rows === 4) pts = [0, 1, 2, 3].map(j => [ap.data32S[2 * j], ap.data32S[2 * j + 1]]);
        else {
          const r = cv.minAreaRect(hull), box = cv.RotatedRect.points(r);
          const hp = []; for (let j = 0; j < hull.rows; j++) hp.push([hull.data32S[2 * j], hull.data32S[2 * j + 1]]);
          pts = box.map(bp => hp.reduce((a, b) => dist(a, [bp.x, bp.y]) < dist(b, [bp.x, bp.y]) ? a : b));
        }
        hull.delete(); ap.delete(); c.delete();
        const q = orderQuad(pts);
        const top = dist(q[0], q[1]), bot = dist(q[3], q[2]), lef = dist(q[0], q[3]), rig = dist(q[1], q[2]);
        if (Math.min(top, bot, lef, rig) < 8) continue;
        const aspect = (top + bot) / (lef + rig);
        if (aspect < 2.8 || aspect > 5.4) continue;
        // verify internal column structure
        const cols = this.countColumns(v, q);
        if (cols < 9) continue;
        const score = area * (1 + Math.min(cols, 14) / 14);
        if (!best || score > best.score) best = { quad: q, score, cols, aspect, sides: [top, bot, lef, rig] };
      }
      if (!best) return null;
      best.quad = best.quad.map(([x, y]) => [x / sc, y / sc]);
      best.scale = sc;
      return best;
    } finally { del.forEach(m => m.delete()); }
  }
  /** Photos: try several working resolutions (tables separate better at higher resolution). */
  detectPhoto(src) { for (const ms of [1000, 1400, 2000]) { if (ms > Math.max(src.cols, src.rows) * 1.2 && ms > 1000) break; const d = this.detect(src, ms); if (d) return d; } return null; }
  countColumns(vMask, q) {
    const cv = this.cv, w = 300, h = 80;
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const m = cv.getPerspectiveTransform(a, b), out = new cv.Mat();
    cv.warpPerspective(vMask, out, m, new cv.Size(w, h));
    const proj = new Float32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) proj[x] += out.data[y * w + x] > 0 ? 1 : 0;
    a.delete(); b.delete(); m.delete(); out.delete();
    return peaks(proj, h * 0.45, 2).length;
  }

  /** Quality metrics for a detected quad in a (small) frame. */
  quality(src, det) {
    const cv = this.cv, H = this.homography(det.quad);
    const tbl = this.warp(src, H, [0, 0, 1200, 320], 0.4); // 480x128
    const g = new cv.Mat(); cv.cvtColor(tbl, g, cv.COLOR_RGBA2GRAY);
    const lap = new cv.Mat(); cv.Laplacian(g, lap, cv.CV_32F, 3);
    const m1 = new cv.Mat(), s1 = new cv.Mat(); cv.meanStdDev(lap, m1, s1);
    const m2 = new cv.Mat(), s2 = new cv.Mat(); cv.meanStdDev(g, m2, s2);
    const sharp = s1.data64F[0] / Math.max(8, s2.data64F[0]);
    const mean = m2.data64F[0];
    let glare = 0; for (let i = 0; i < g.data.length; i++) if (g.data[i] >= 250) glare++;
    glare /= g.data.length;
    [tbl, g, lap, m1, s1, m2, s2].forEach(m => m.delete());
    const [x0, y0, x1, y1] = T.mustSee, W = src.cols, Hh = src.rows, mg = 0.004 * Math.max(W, Hh);
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => apply(H, x, y));
    const inFrame = corners.every(([x, y]) => x > mg && y > mg && x < W - mg && y < Hh - mg);
    const [top, bot, lef, rig] = det.sides;
    const persp = Math.max(top / bot, bot / top, lef / rig, rig / lef);
    return { sharp, mean, glare, inFrame, persp, tablePx: (top + bot) / 2 };
  }

  // ---------- full extraction on the captured frame ----------
  /** Everything outside the marks table: register strip, CO Total and grand total. */
  extractOthers(src, H) {
    const t1 = performance.now(), reg = this.extractRegister(src, H);
    const cells = { ...reg.cells, coTotal: this.extractCoTotal(src, H), grand: this.extractGrand(src, H) };
    return { cells, register: reg, ms: performance.now() - t1 };
  }
  extract(src, quad) { const t = this.extractTable(src, quad), o = this.extractOthers(src, t.H); Object.assign(t.cells, o.cells); t.register = o.register; t.timings.others = o.ms; return t; }

  extractTable(src, quad) {
    const cv = this.cv, t0 = performance.now(), del = [];
    const H = this.homography(quad);
    const out = { cells: {}, debug: {} };
    try {
      // --- marks table ---
      const R = [-10, -10, 1210, 330], TS = this.tableScale;
      const tbl = this.warp(src, H, R, TS); del.push(tbl);
      const [mx, mn] = this.maxMin(tbl); del.push(mx, mn);
      const [h, v] = this.lineMasks(mx, 150 * TS, 150 * TS, 25, 8); del.push(h, v);
      const W = tbl.cols, Hh = tbl.rows;
      const pv = new Float32Array(W), ph = new Float32Array(Hh);
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (v.data[i]) pv[x]++; if (h.data[i]) ph[y]++; }
      const cols = snap(T.colLines.map(c => (c + 10) * TS), peaks(pv, Hh * 0.3), 18 * TS);
      const rows = snap(T.rowLines.map(r => (r + 10) * TS), peaks(ph, W * 0.3), 16 * TS);
      out.debug.cols = cols; out.debug.rows = rows;
      const lines = new cv.Mat(); del.push(lines); cv.bitwise_or(h, v, lines);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(lines, lines, k); k.delete();
      const put = (key, x0, y0, x1, y1) => { out.cells[key] = this.cellCrop(tbl, lines, x0, y0, x1, y1, 0.08); };
      for (let i = 0; i < 10; i++) {
        put(PART_A[i], cols[i + 2], rows[1], cols[i + 3], rows[2]);
        put(PART_B[i], cols[i + 2], rows[3], cols[i + 3], rows[4]);
      }
      put('totalA', cols[12], rows[1], cols[13], rows[2]);
      put('totalB', cols[12], rows[3], cols[13], rows[4]);
      out.timings = { table: performance.now() - t0 };
      out.H = H;
      return out;
    } finally { del.forEach(m => m.delete()); }
  }

  /** Copy a padded cell (RGBA + line mask) out of a warped region. */
  cellCrop(img, lines, x0, y0, x1, y1, pad) {
    const pw = (x1 - x0) * pad, ph = (y1 - y0) * pad;
    const X0 = Math.max(0, Math.round(x0 - pw)), Y0 = Math.max(0, Math.round(y0 - ph));
    const X1 = Math.min(img.cols, Math.round(x1 + pw)), Y1 = Math.min(img.rows, Math.round(y1 + ph));
    const w = X1 - X0, h = Y1 - Y0, rgba = new Uint8ClampedArray(w * h * 4), line = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const so = ((Y0 + y) * img.cols + X0) * 4;
      rgba.set(img.data.subarray(so, so + w * 4), y * w * 4);
      if (lines) { const lo = (Y0 + y) * lines.cols + X0; line.set(lines.data.subarray(lo, lo + w), y * w); }
    }
    return { w, h, rgba, line, pad: { l: x0 - X0, t: y0 - Y0, r: X1 - x1, b: Y1 - y1 } };
  }

  /** Locate the best rectangular box inside a warped window. */
  findBox(win, aspect, minWFrac, hLen, vLen, opts = {}) {
    const cv = this.cv, del = [];
    try {
      const [mx, mn] = this.maxMin(win); del.push(mx, mn);
      const [h, v] = this.lineMasks(mx, hLen, vLen, 25, 8); del.push(h, v);
      const g = new cv.Mat(); del.push(g); cv.bitwise_or(h, v, g);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(g, g, k); k.delete();
      const cs = new cv.MatVector(), hi = new cv.Mat(); del.push(cs, hi);
      cv.findContours(g, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = null;
      for (let i = 0; i < cs.size(); i++) {
        const c = cs.get(i), r = cv.boundingRect(c); c.delete();
        const a = r.width / Math.max(1, r.height);
        if (a < aspect[0] || a > aspect[1] || r.width < minWFrac * win.cols) continue;
        if (!best || r.width * r.height > best.width * best.height) best = r;
      }
      if (!best) return null;
      // projections inside the box
      const pv = new Float32Array(best.width), ph = new Float32Array(best.height);
      for (let y = 0; y < best.height; y++) for (let x = 0; x < best.width; x++) {
        const i = (best.y + y) * win.cols + best.x + x; if (v.data[i]) pv[x]++; if (h.data[i]) ph[y]++;
      }
      const lines = new cv.Mat(); cv.bitwise_or(h, v, lines);
      const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(lines, lines, k2); k2.delete();
      const hData = opts.keepH ? h.data.slice() : null;
      return { rect: best, pv, ph, lines, hData };
    } finally { del.forEach(m => m.delete()); }
  }

  /** Line segments (connected components of the h/v line masks) inside a warped window. */
  segments(win, hLen, vLen) {
    const cv = this.cv, [mx, mn] = this.maxMin(win), [h, v] = this.lineMasks(mx, hLen, vLen, 25, 8);
    const comps = m => {
      const lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
      const n = cv.connectedComponentsWithStats(m, lab, st, ce, 8, cv.CV_32S), out = [];
      for (let i = 1; i < n; i++) { const d = st.data32S, o = i * 5; out.push({ x: d[o], y: d[o + 1], w: d[o + 2], h: d[o + 3], cx: d[o] + d[o + 2] / 2, cy: d[o + 1] + d[o + 3] / 2 }); }
      [lab, st, ce].forEach(x => x.delete()); return out;
    };
    const vs = comps(v), hs = comps(h);
    const lines = new cv.Mat(); cv.bitwise_or(h, v, lines);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(lines, lines, k); k.delete();
    [mx, mn, h, v].forEach(x => x.delete());
    return { vs, hs, lines };
  }

  extractRegister(src, H) {
    const S = this.regScale, cfg = T.register, win = this.warp(src, H, cfg.win, S);
    const cells = {}; let ok = false, xs, top, bot;
    const { vs, lines } = this.segments(win, 90 * S, 45 * S);
    try {
      // cell dividers: short vertical segments of similar height, evenly spaced
      const cand = vs.filter(c => c.h >= 50 * S && c.h <= 170 * S && c.w <= 14 * S).sort((a, b) => a.cx - b.cx);
      let best = null;
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const sp = (cand[j].cx - cand[i].cx) / cfg.cells; if (sp < 36 * S || sp > 80 * S) continue;
        const hit = [];
        for (let k = 0; k <= cfg.cells; k++) {
          const e = cand[i].cx + k * sp;
          const m = cand.filter(c => Math.abs(c.cx - e) < 0.2 * sp && Math.abs(c.cy - (cand[i].cy + (cand[j].cy - cand[i].cy) * k / cfg.cells)) < 0.45 * cand[i].h)
            .sort((a, b) => Math.abs(a.cx - e) - Math.abs(b.cx - e))[0];
          if (m) hit.push({ k, c: m });
        }
        if (!best || hit.length > best.hit.length || (hit.length === best.hit.length && sp > best.sp)) best = { hit, sp, x0: cand[i].cx };
      }
      if (best && best.hit.length >= 9) {
        // least-squares fit of divider x, top and bottom against index k (handles tilt)
        const fit = f => { const n = best.hit.length, sx = best.hit.reduce((a, q) => a + q.k, 0), sy = best.hit.reduce((a, q) => a + f(q.c), 0);
          const sxx = best.hit.reduce((a, q) => a + q.k * q.k, 0), sxy = best.hit.reduce((a, q) => a + q.k * f(q.c), 0);
          const b = (n * sxy - sx * sy) / Math.max(1e-6, n * sxx - sx * sx); return k => (sy - b * sx) / n + b * k; };
        const fx = fit(c => c.cx), ft = fit(c => c.y), fb = fit(c => c.y + c.h);
        xs = Array.from({ length: cfg.cells + 1 }, (_, k) => fx(k));
        top = k => Math.min(ft(k), ft(k + 1)); bot = k => Math.max(fb(k), fb(k + 1));
        ok = true;
      }
      if (!ok) {
        const f = T.fallback.register, X0 = (f[0] - cfg.win[0]) * S, X1 = (f[2] - cfg.win[0]) * S;
        xs = Array.from({ length: cfg.cells + 1 }, (_, k) => X0 + (X1 - X0) * k / cfg.cells);
        top = () => (f[1] - cfg.win[1]) * S; bot = () => (f[3] - cfg.win[1]) * S;
      }
      for (let k = 0; k < cfg.cells; k++) cells[`reg${k + 1}`] = this.cellCrop(win, lines, xs[k], top(k), xs[k + 1], bot(k), 0.06);
      return { cells, located: ok };
    } finally { win.delete(); lines.delete(); }
  }

  extractCoTotal(src, H) {
    const S = this.boxScale, cfg = T.co, win = this.warp(src, H, cfg.win, S);
    const { vs, hs, lines } = this.segments(win, 60 * S, 50 * S);
    try {
      // right border and the divider left of the "Total" column: the two right-most tall verticals
      const tall = vs.filter(c => c.h >= 110 * S && c.w <= 16 * S && c.cx > win.cols * 0.45).sort((a, b) => b.cx - a.cx);
      if (tall.length >= 2) {
        const xR = tall[0].cx, xL = tall.find(c => xR - c.cx > 120 * S && xR - c.cx < 300 * S)?.cx;
        if (xL != null) {
          const ys = hs.filter(c => c.x <= xL + 12 * S && c.x + c.w >= xR - 12 * S).map(c => c.cy).sort((a, b) => a - b);
          const bottom = Math.min(tall[0].y + tall[0].h, win.rows - 1);
          const yB = ys.filter(y => y <= bottom + 8 * S).pop() ?? bottom;
          const yT = ys.filter(y => y < yB - 50 * S).pop();
          if (yT != null) return { ...this.cellCrop(win, lines, xL, yT, xR, yB, 0.06), located: true };
        }
      }
      const f = T.fallback.coTotal;
      return { ...this.cellCrop(win, lines, (f[0] - cfg.win[0]) * S, (f[1] - cfg.win[1]) * S, (f[2] - cfg.win[0]) * S, (f[3] - cfg.win[1]) * S, 0.06), located: false };
    } finally { win.delete(); lines.delete(); }
  }

  extractGrand(src, H) {
    const S = this.boxScale, cfg = T.grand, win = this.warp(src, H, cfg.win, S); let lines = null;
    try {
      const fb = this.findBox(win, cfg.aspect, 0.5, 150 * S, 45 * S);
      if (fb) {
        lines = fb.lines; const r = fb.rect, ix = r.width * 0.03, iy = r.height * 0.06;
        return { ...this.cellCrop(win, lines, r.x + ix, r.y + iy, r.x + r.width - ix, r.y + r.height - iy, 0.04), located: true };
      }
      const f = T.fallback.grand;
      return { ...this.cellCrop(win, null, (f[0] - cfg.win[0]) * S, (f[1] - cfg.win[1]) * S, (f[2] - cfg.win[0]) * S, (f[3] - cfg.win[1]) * S, 0.04), located: false };
    } finally { win.delete(); if (lines) lines.delete(); }
  }

  /** Warp the review image (register row to grand total) for storage/preview. */
  rectified(src, H, S = 0.6) { return this.warp(src, H, [-60, -800, 2160, 480], S); }
}

// ---------- pure-JS ink isolation on a cell crop ----------
export function isolate(cell, opt = {}) {
  const PY = opt.padY ?? 0.25, PX = opt.padX ?? 0.35, GRAY = opt.gray ?? true;
  const { w: W, h: H, rgba, line, pad } = cell, N = W * H;
  const mn = new Uint8Array(N);
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
    const m = r < g ? (r < b ? r : b) : (g < b ? g : b); mn[i] = m; hist[m]++;
  }
  const pct = q => { let c = 0; const t = q * N; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= t) return v; } return 255; };
  const bg = pct(0.70), dark = pct(0.005), thr = Math.max(35, 0.42 * (bg - dark));
  let ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = (bg - mn[i] > thr && !line[i]) ? 1 : 0;
  // opening with 2x2
  const er = new Uint8Array(N);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const i = y * W + x; er[i] = ink[i] & ink[i + 1] & ink[i + W] & ink[i + W + 1]; }
  const op = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (er[i] || (x && er[i - 1]) || (y && er[i - W]) || (x && y && er[i - W - 1])) op[i] = 1; }
  ink = op;
  // connected components (8-conn)
  const lab = new Int32Array(N); const comps = []; const stack = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (!ink[i] || lab[i]) continue;
    const id = comps.length + 1; let sp = 0; stack[sp++] = i; lab[i] = id;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, a = 0, inside = 0;
    const cx0 = pad.l, cx1 = W - pad.r, cy0 = pad.t, cy1 = H - pad.b;
    while (sp) {
      const p = stack[--sp], x = p % W, y = (p / W) | 0; a++;
      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) inside++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx; if (ink[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; }
      }
    }
    comps.push({ id, a, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, inside: inside / a });
  }
  const coreW = W - pad.l - pad.r, coreH = H - pad.t - pad.b;
  const good = comps.filter(c => {
    if (c.a < Math.max(6, 0.0015 * N)) return false;
    if (c.h <= 0.05 * H && c.w > 0.3 * W) return false;                 // horizontal line residue
    if (c.w <= 0.05 * W && c.h > 0.35 * H && (c.x < pad.l + 2 || c.x + c.w > W - pad.r - 2)) return false; // vertical residue
    if (c.h <= 0.06 * H && c.w <= 0.06 * W && c.a < 0.004 * N) return false; // specks
    return c.inside >= 0.5;                                              // belongs to this cell
  });
  if (!good.length) return { blank: true };
  good.sort((a, b) => b.a - a.a);
  const L = good[0];
  const ex0 = L.x - 0.9 * L.h, ex1 = L.x + L.w + 0.9 * L.h, ey0 = L.y - 0.5 * L.h, ey1 = L.y + 1.5 * L.h;
  const sel = good.filter(c => c.a >= 0.12 * L.a || (c.x + c.w > ex0 && c.x < ex1 && c.y + c.h > ey0 && c.y < ey1));
  const keep = new Uint8Array(comps.length + 1); sel.forEach(c => keep[c.id] = 1);
  let x0 = W, y0 = H, x1 = 0, y1 = 0, inkPx = 0;
  for (const c of sel) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); inkPx += c.a; }
  const iw = x1 - x0, ih = y1 - y0, aspect = iw / Math.max(1, ih), hfrac = ih / coreH;
  const dash = (sel.length <= 2 && aspect >= 2.0 && hfrac < 0.35) || (aspect >= 3.2 && hfrac < 0.3);
  if (hfrac < 0.12 && iw < 0.12 * coreW) return { blank: true, speck: true };
  // soft mask (dilate 1 + blur-ish) and white background composition; tiny digits keep a crisp mask
  const small = ih < 30, soft = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      n++; if (keep[lab[ny * W + nx]]) s++;
    }
    soft[y * W + x] = keep[lab[y * W + x]] ? 1 : (small ? 0 : Math.min(1, s / n * 1.5));
  }
  const py = Math.max(4, Math.round(ih * PY)), px = Math.max(4, Math.round(ih * PX));
  const ow = iw + 2 * px, oh = ih + 2 * py, o = new Uint8ClampedArray(ow * oh * 4).fill(255);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const si = (y0 + y) * W + x0 + x, a = soft[si], di = ((y + py) * ow + x + px) * 4;
    if (GRAY) { // pen colour normalised to a dark stroke: red, blue and black ink all look alike
      const v = Math.max(0, Math.min(255, (mn[si] - dark) / Math.max(1, bg - dark) * 255)) * a + 255 * (1 - a);
      o[di] = o[di + 1] = o[di + 2] = v;
    } else { o[di] = rgba[4 * si] * a + 255 * (1 - a); o[di + 1] = rgba[4 * si + 1] * a + 255 * (1 - a); o[di + 2] = rgba[4 * si + 2] * a + 255 * (1 - a); }
  }
    // stroke layout: helps recover "11" when CTC merges two adjacent 1s
  const tall = sel.filter(c => c.h >= 0.6 * ih && c.w / c.h < 0.5).sort((a, b) => a.x - b.x);
  let ones = 0; for (let i = 0; i < tall.length; i++) if (i === 0 || tall[i].x >= tall[i - 1].x + tall[i - 1].w - 1) ones++;
  const thinStrokes = tall.length === sel.filter(c => c.a > 0.1 * inkPx).length ? ones : 0;
  return { blank: false, dash, crop: { w: ow, h: oh, rgba: o }, info: { aspect, hfrac, n: sel.length, inkPx, thinStrokes } };
}
