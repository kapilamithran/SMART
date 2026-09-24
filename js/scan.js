// Captured frame → editable record. Shared by the app, the benchmark page and Node tests.
import { isolate } from './pipeline.js';
import { fieldFromOcr, applyTotalsRule, evaluate } from './rules.js';
import { TEMPLATE } from './template.js';

export async function recognizeFrame({ pipe, rec, src, det, verifyPrefix = false, refine = true, refineSide = 1400, secondOpinion = false }) {
  const t = { start: performance.now() };
  let d = det;
  // refine the table quad at higher resolution than the live detector used
  if (!d || refine) { const refined = pipe.detect(src, Math.min(refineSide, Math.max(src.cols, src.rows))); if (refined) d = refined; }
  if (!d) throw new Error('Booklet table not found');
  t.detect = performance.now();
  // stage 1: marks table → start OCR (runs in the ORT worker when available)
  const ex = pipe.extractTable(src, d.quad);
  const iso = {};
  const prep = keysList => { const crops = [], order = []; for (const k of keysList) {
      if (!verifyPrefix && /^reg[1-4]$/.test(k)) continue;
      const r = isolate(ex.cells[k]); iso[k] = r;
      if (!r.blank && !r.dash) { order.push(k); crops.push(r.crop); } } return { crops, order }; };
  const s1 = prep(Object.keys(ex.cells));
  const p1 = rec.recognize(s1.crops);
  t.extract = performance.now();
  // stage 2 (overlaps with stage-1 inference): register, CO total, grand total
  const ot = pipe.extractOthers(src, ex.H);
  Object.assign(ex.cells, ot.cells); ex.register = ot.register;
  const s2 = prep(Object.keys(ot.cells));
  t.isolate = performance.now();
  const [o1, o2] = await Promise.all([p1, rec.recognize(s2.crops)]);
  const out = [...o1, ...o2], order = [...s1.order, ...s2.order], crops = [...s1.crops, ...s2.crops];
  const keys = Object.keys(ex.cells);
  t.ocr = performance.now();
  // second opinion for doubtful crops only: colour crop with wider margins
  let second = 0;
  if (secondOpinion) {
    const redo = order.map((k, i) => (out[i].conf < 0.85 ? i : -1)).filter(i => i >= 0);
    if (redo.length) {
      const alt = await rec.recognize(redo.map(i => isolate(ex.cells[order[i]], { gray: false, padY: 0.35, padX: 0.5 }).crop));
      redo.forEach((i, j) => {
        const a = alt[j], o = out[i]; if (!a) return;
        if (a.text === o.text) { o.conf = Math.min(0.97, Math.max(o.conf, a.conf) + 0.1); o.agreed = true; }
        else if (a.conf > o.conf + 0.1 && a.text !== '') { o.alts = [{ text: o.text, p: o.conf }, ...o.alts]; Object.assign(o, { text: a.text, conf: a.conf * 0.9, alts: [...a.alts, ...o.alts], secondOpinion: true }); }
        else o.alts = [...o.alts, ...a.alts.map(x => ({ text: x.text, p: x.p * 0.8 }))];
      });
      second = redo.length;
    }
  }
  t.second = performance.now();

  const fields = {};
  const prefix = TEMPLATE.register.prefix;
  for (const k of keys) {
    if (!verifyPrefix && /^reg[1-4]$/.test(k)) {
      const i = +k.slice(3) - 1;
      fields[k] = { key: k, kind: 'reg', raw: prefix[i], text: prefix[i], conf: 1, alts: [], fromOcr: false, fixed: true, edited: false, flags: [] };
      continue;
    }
    const r = iso[k];
    if (r.blank || r.dash) {
      fields[k] = fieldFromOcr(k, { text: '', conf: 1, alts: [], dash: !!r.dash });
      fields[k].inkBlank = r.blank ? 'no ink' : 'dash';
    } else {
      const o = out[order.indexOf(k)];
      // CTC merges two touching-in-time 1s: separate thin vertical strokes prove there are more
      if (/^1+$/.test(o.text) && r.info.thinStrokes > o.text.length && !/^reg/.test(k)) {
        const t2 = '1'.repeat(r.info.thinStrokes);
        o.alts = [{ text: t2, p: 0.6 }, ...o.alts.filter(a => a.text !== t2).map(a => ({ text: a.text, p: a.p * 0.4 }))];
        o.text = t2; o.conf = Math.min(o.conf, 0.7); o.strokeFix = true;
      }
      if (o.text === '' && r.info.thinStrokes >= 1 && !/^reg/.test(k)) {
        o.text = '1'.repeat(r.info.thinStrokes); o.conf = 0.5; o.strokeFix = true;
        o.alts = [{ text: o.text, p: 0.5 }, ...o.alts.map(a => ({ text: a.text, p: a.p * 0.5 }))];
      }
      if (/^reg/.test(k) && !/^\d$/.test(o.text) && o.alts.length) {
        // a register box holds exactly one digit: keep the best digit but mark it doubtful
        const d = o.alts.find(a => /^\d$/.test(a.text));
        if (d) { o.readAs = o.text; o.text = d.text; o.conf = Math.min(o.conf || d.p, 0.5); }
      }
      fields[k] = fieldFromOcr(k, o);
      if (o.text === '') fields[k].conf = 0; // ink present but nothing recognised → doubtful
    }
  }
  if (verifyPrefix) {
    const got = [1, 2, 3, 4].map(i => fields[`reg${i}`].text).join('');
    if (got !== prefix) for (let i = 1; i <= 4; i++) fields[`reg${i}`].prefixMismatch = true;
  }
  // resolution guard: register digits are ~40 units tall; below ~0.6 px/unit they are too small to read reliably
  const q = d.quad, pxPerUnit = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2 / 1200;
  const lowRes = pxPerUnit < 0.6;
  if (lowRes) for (const k of keys) if (/^reg/.test(k) && fields[k].fromOcr) {
    fields[k].conf = Math.min(fields[k].conf ?? 1, 0.4); fields[k].lowRes = true;
  }
  const record = {
    lowRes, pxPerUnit: +pxPerUnit.toFixed(2),
    id: (globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random())),
    createdAt: new Date().toISOString(),
    fields,
    ocrSnapshot: Object.fromEntries(keys.map(k => [k, { raw: fields[k].raw, conf: +(fields[k].conf ?? 1).toFixed(3), alts: fields[k].alts }])),
    located: { register: ex.register.located, co: ex.cells.coTotal.located, grand: ex.cells.grand.located },
    quad: d.quad,
  };
  applyTotalsRule(record);
  evaluate(record);
  t.rules = performance.now();
  record.timings = {
    detect: t.detect - t.start, table: t.extract - t.detect, others: t.isolate - t.extract,
    ocr: t.ocr - t.isolate, second: t.second - t.ocr, secondCrops: second, rules: t.rules - t.second, crops: crops.length, total: t.rules - t.start,
  };
  return { record, cells: ex.cells, H: ex.H };
}
