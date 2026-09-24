// Live camera loop: automatic form detection, quality checks, steady-frame capture,
// duplicate-page prevention. Emits onCapture({ src (cv.Mat full res), det, tSteady, jpegCanvas }).
export const QUALITY = { minSharp: 1.4, minMean: 70, maxMean: 245, maxGlare: 0.02, maxPersp: 1.45, minTableFrac: 0.26 };

export class Camera {
  constructor({ cv, pipe, video, overlay, onStatus, onSteady, getKnownHashes }) {
    Object.assign(this, { cv, pipe, video, overlay, onStatus, onSteady, getKnownHashes });
    this.autoCapture = false;
    this.small = document.createElement('canvas');
    this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    this.full = document.createElement('canvas');
    this.fctx = this.full.getContext('2d', { willReadFrequently: true });
    this.hist = []; this.running = false; this.armed = true; this.lastHash = null; this.lostSince = 0;
    this.steadyMs = 350;
  }
  async start() {
    if (this.stream) { this.running = true; this.loop(); return; }
    const c = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } } };
    this.stream = await navigator.mediaDevices.getUserMedia(c);
    this.video.srcObject = this.stream; await this.video.play();
    const track = this.stream.getVideoTracks()[0];
    try { const caps = track.getCapabilities?.(); if (caps?.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { }
    this.track = track; this.running = true; this.loop();
  }
  stop() { this.running = false; }
  release() { this.running = false; this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; }
  async torch(on) { try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; } }
  rearm() { this.armed = true; this.hist = []; }

  /** Full-resolution still from the rear camera (ImageCapture), else the current video frame. */
  async takePhoto() {
    const wasRunning = this.running; this.running = false;
    try {
      if (this.track && 'ImageCapture' in window) {
        const ic = new ImageCapture(this.track);
        const blob = await ic.takePhoto();
        return { blob, via: 'photo' };
      }
    } catch (e) { console.warn('takePhoto failed, using video frame', e); }
    finally { if (wasRunning) this.running = false; }
    const v = this.video; this.full.width = v.videoWidth; this.full.height = v.videoHeight;
    this.fctx.drawImage(v, 0, 0); return { canvas: this.full, via: 'video' };
  }

  loop() {
    if (!this.running) return;
    const tick = () => { if (!this.running) return; try { this.analyse(); } catch (e) { console.error(e); } };
    if (this.video.requestVideoFrameCallback) {
      const step = () => { if (!this.running) return; tick(); setTimeout(() => this.running && this.video.requestVideoFrameCallback(step), 70); };
      this.video.requestVideoFrameCallback(step);
    } else { const step = () => { if (!this.running) return; tick(); setTimeout(step, 90); }; step(); }
  }

  analyse() {
    const cv = this.cv, v = this.video, W = v.videoWidth, H = v.videoHeight;
    if (!W) return;
    const sc = 800 / Math.max(W, H);
    this.small.width = Math.round(W * sc); this.small.height = Math.round(H * sc);
    this.sctx.drawImage(v, 0, 0, this.small.width, this.small.height);
    const img = this.sctx.getImageData(0, 0, this.small.width, this.small.height);
    const m = cv.matFromImageData(img);
    let det = null, q = null, hash = null;
    try {
      det = this.pipe.detect(m, 800);
      if (det) { q = this.pipe.quality(m, det); hash = pageHash(this.pipe, m, det); }
    } finally { m.delete(); }
    const now = performance.now();
    this.draw(det, q, sc);
    if (!det) {
      if (!this.lostSince) this.lostSince = now;
      if (now - this.lostSince > 700) this.armed = true;           // booklet removed → ready for the next
      this.hist = []; return this.onStatus({ state: 'search', msg: 'Point at the marks table of the booklet cover' });
    }
    this.lostSince = 0;
    // new page even without leaving the frame (hash moved far from the last capture)
    if (!this.armed && this.lastHash && hamming(hash, this.lastHash) > 0.22) this.armed = true;
    const issues = [];
    if (q.tablePx < QUALITY.minTableFrac * 800) issues.push('Move closer');
    if (!q.inFrame) issues.push('Fit the whole cover (register number to grand total) in view');
    if (q.persp > QUALITY.maxPersp) issues.push('Hold the phone flatter');
    if (q.mean < QUALITY.minMean) issues.push('Too dark — add light or use torch');
    if (q.mean > QUALITY.maxMean || q.glare > QUALITY.maxGlare) issues.push('Glare — tilt slightly away from the light');
    if (q.sharp < QUALITY.minSharp) issues.push('Blurry — hold still / tap to focus');
    const n = det.quad; // detection ran on the 800-px frame
    this.hist.push({ t: now, n }); this.hist = this.hist.filter(h => now - h.t < 900);
    const ref = this.hist.find(h => now - h.t <= this.steadyMs) || this.hist[0];
    const tw = Math.hypot(n[1][0] - n[0][0], n[1][1] - n[0][1]);
    const recent = this.hist.filter(h => now - h.t <= this.steadyMs);
    const move = Math.max(...recent.map(h => Math.max(...h.n.map((p, i) => Math.hypot(p[0] - n[i][0], p[1] - n[i][1]))))) / tw;
    const steady = recent.length >= 3 && now - recent[0].t >= this.steadyMs * 0.8 && move < 0.012;
    if (!this.armed) return this.onStatus({ state: 'done', msg: 'Captured — show the next booklet', q });
    if (issues.length) return this.onStatus({ state: 'bad', msg: issues[0], q, issues });
    if (!this.autoCapture) return this.onStatus({ state: 'ready', msg: 'Looks good — tap Take photo', q });
    const known = (this.getKnownHashes?.() || []).find(k => hamming(hash, k.hash) < 0.08);
    if (known) { this.armed = false; this.lastHash = hash; return this.onStatus({ state: 'dup', msg: `Already scanned (${known.label}) — show a different booklet`, q }); }
    if (!steady) return this.onStatus({ state: 'hold', msg: 'Hold steady…', q, move });
    // optional auto mode: steady & good → take a full-resolution photo
    this.armed = false; this.lastHash = hash; this.running = false;
    this.onStatus({ state: 'capture', msg: 'Taking photo…' });
    this.onSteady?.(now);
  }

  draw(det, q, sc) {
    const o = this.overlay, v = this.video, ctx = o.getContext('2d');
    const r = o.getBoundingClientRect(); o.width = r.width * devicePixelRatio; o.height = r.height * devicePixelRatio;
    ctx.clearRect(0, 0, o.width, o.height);
    if (!det) return;
    // map video pixels → displayed (object-fit: cover)
    const W = v.videoWidth, H = v.videoHeight, s = Math.min(o.width / W, o.height / H); // object-fit: contain
    const ox = (o.width - W * s) / 2, oy = (o.height - H * s) / 2;
    ctx.lineWidth = 3 * devicePixelRatio; ctx.strokeStyle = q && q.inFrame && q.sharp >= QUALITY.minSharp ? '#18a99a' : '#d9a84e';
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 12;
    ctx.beginPath(); det.quad.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](ox + x / sc * s, oy + y / sc * s)); ctx.closePath(); ctx.stroke();
  }
}

// 16x8 difference hash of the rectified marks-table region (handwriting changes it per student)
export function pageHash(pipe, m, det) {
  const H = pipe.homography(det.quad), w = pipe.warp(m, H, [165, 75, 1197, 318], 0.1); // ~103x24
  const cv = pipe.cv, g = new cv.Mat(); cv.cvtColor(w, g, cv.COLOR_RGBA2GRAY);
  const s = new cv.Mat(); cv.resize(g, s, new cv.Size(17, 8), 0, 0, cv.INTER_AREA);
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) bits.push(s.data[y * 17 + x] > s.data[y * 17 + x + 1] ? 1 : 0);
  [w, g, s].forEach(x => x.delete());
  return bits.join('');
}
export function hamming(a, b) { if (!a || !b) return 1; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d / a.length; }
