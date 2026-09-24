// Pure rule logic (no DOM) — shared by the app, the benchmark and the Node tests.
import { PART_A, PART_B } from './template.js';

export const LIMITS = {
  A: { max: 2, termMax: 2, label: '0, 1 or 2' },
  B: { max: 11, termMax: 11, label: '0–11' },
  totalA: { max: 20 }, totalB: { max: 55 }, grand: { max: 75 }, coTotal: { max: 75 },
};
export const CONF = { A: 0.80, B: 0.75, total: 0.80, reg: 0.85 };

export function kindOf(key) {
  if (/^Q\d+$/.test(key)) return 'A';
  if (/^1[1-5][ab]$/.test(key)) return 'B';
  if (/^reg\d+$/.test(key)) return 'reg';
  return 'total';
}

/** Parse a cell text. Never truncates, never clamps. */
export function parseMark(text, key) {
  const kind = kindOf(key);
  const t = String(text ?? '').replace(/\s+/g, '').replace(/[−–—_一]/g, '-');
  if (t === '' || /^-+$/.test(t)) return { blank: true, value: null };
  if (kind === 'reg') {
    return /^\d$/.test(t) ? { value: +t } : { invalid: 'one digit expected', value: null };
  }
  const termRe = kind === 'A' ? /^\d(\+\d)*$/ : kind === 'B' ? /^\d{1,2}(\+\d{1,2})*$/ : /^\d{1,3}(\+\d{1,3})*$/;
  if (!termRe.test(t)) {
    if (kind === 'A' && /^\d{2,}$/.test(t)) return { invalid: `reads "${t}" — one digit (0, 1 or 2) expected; not truncated`, value: null };
    return { invalid: `unreadable "${t}"`, value: null };
  }
  const terms = t.split('+').map(Number);
  const sum = terms.reduce((a, b) => a + b, 0);
  if (kind === 'A' || kind === 'B') {
    const L = LIMITS[kind];
    if (terms.some(x => x > L.termMax) || sum > L.max) return { invalid: `"${t}" is outside ${L.label}`, value: null };
  } else if (sum > LIMITS[key].max) {
    return { invalid: `"${t}" is above the maximum ${LIMITS[key].max}`, value: null };
  }
  return { value: sum, expr: terms.length > 1 ? t : null };
}

/** Build a field object from an OCR reading. */
export function fieldFromOcr(key, ocr) {
  // ocr: { text, conf, alts:[{text,p}], blankByInk, dash, crop }
  const f = { key, kind: kindOf(key), raw: ocr ? ocr.text : '', conf: ocr ? ocr.conf : 1,
    alts: ocr?.alts || [], dash: !!ocr?.dash, fromOcr: true, edited: false,
    text: ocr ? ocr.text : '', value: null, ocrValue: null, flags: [], suggestion: null, excluded: false };
  const p = parseMark(f.text, key);
  f.ocrValue = p.value;
  // never silently force: an unparseable or out-of-range top reading stays empty
  if (p.invalid) f.text = f.raw;
  return f;
}

function addFlag(f, level, msg) { f.flags.push({ level, msg }); }

/** Candidate values implied by the OCR alternatives (for suggestions only). */
function candidateValues(f) {
  const out = [];
  for (const a of f.alts || []) {
    const p = parseMark(a.text, f.key);
    if (p.value != null && !out.some(o => o.value === p.value)) out.push({ value: p.value, p: a.p });
  }
  return out;
}

/** Totals rule — applied once when a record is created from a scan. Mutates. */
export function applyTotalsRule(rec) {
  const F = rec.fields;
  const wA = parseMark(F.totalA.text, 'totalA').value;
  const wB = parseMark(F.totalB.text, 'totalB').value;
  rec.audit = rec.audit || {};
  rec.audit.totalsRule = null;
  if (wA == null || wB == null) return;
  const exp = wA + wB;
  const g = F.grand.ocrValue, c = F.coTotal.ocrValue;
  if (g === exp || c === exp) {
    const src = g === exp && c === exp ? 'grand total and CO total' : g === exp ? 'grand total' : 'CO total';
    for (const k of ['grand', 'coTotal']) {
      if (F[k].ocrValue !== exp) {
        F[k].autoFilled = { from: F[k].raw || '(blank)', to: exp, why: `${src} equals written A + B = ${wA} + ${wB}` };
      }
      F[k].text = String(exp);
    }
    rec.audit.totalsRule = { expected: exp, matched: src, grandRead: F.grand.raw, coRead: F.coTotal.raw };
  }
}

/** Full evaluation: values, flags, sums and suggestions. Mutates rec and returns a summary. */
export function evaluate(rec) {
  const F = rec.fields;
  const keys = Object.keys(F);
  for (const k of keys) {
    const f = F[k];
    f.flags = []; f.suggestion = null; f.excluded = false;
    const p = parseMark(f.text, k);
    f.value = p.value; f.blank = !!p.blank; f.invalid = p.invalid || null; f.expr = p.expr || null;
    if (p.invalid) addFlag(f, 'red', p.invalid);
    const thr = CONF[f.kind === 'total' ? 'total' : f.kind] ?? 0.8;
    if (f.fromOcr && !f.edited && !p.blank && f.conf < thr) {
      const alt = (f.alts || []).filter(a => a.text !== f.raw).slice(0, 2)
        .map(a => `${a.text} (${Math.round(a.p * 100)}%)`).join(', ');
      addFlag(f, 'red', (f.lowRes ? 'photo too low-resolution for this box — ' : '') + `doubtful reading "${f.raw}" (${Math.round(f.conf * 100)}%)` + (alt ? ` — also possible: ${alt}` : ''));
    }
    if (f.autoFilled && !f.edited) addFlag(f, 'info', `auto-filled ${f.autoFilled.to} (read "${f.autoFilled.from}") — ${f.autoFilled.why}`);
  }
  // Part B: only one alternative per question
  for (let q = 11; q <= 15; q++) {
    const a = F[`${q}a`], b = F[`${q}b`];
    if (a.value != null && b.value != null) {
      const drop = b.value > a.value ? a : b;
      const keep = drop === a ? b : a;
      drop.excluded = true;
      addFlag(drop, 'red', `both ${q}a and ${q}b have marks — kept the higher (${keep.key} = ${keep.value}); this one is excluded from the sum`);
    }
  }
  const sum = list => list.reduce((s, k) => s + (F[k].excluded ? 0 : (F[k].value ?? 0)), 0);
  const calcA = sum(PART_A), calcB = sum(PART_B);
  const incA = PART_A.some(k => F[k].invalid), incB = PART_B.some(k => F[k].invalid);
  const wA = F.totalA.value, wB = F.totalB.value, g = F.grand.value, c = F.coTotal.value;
  const S = { calcA, calcB, calcTotal: calcA + calcB, incA, incB, writtenA: wA, writtenB: wB, grand: g, co: c,
    writtenSum: wA != null && wB != null ? wA + wB : null, issues: [] };

  const section = (keysList, wKey, calc, name) => {
    const w = F[wKey].value;
    if (w == null) { addFlag(F[wKey], 'red', `${name} total missing — calculated ${calc}`); S.issues.push(`${name}: written total missing (calculated ${calc})`); return; }
    if (w === calc) return;
    const diff = w - calc;
    addFlag(F[wKey], 'red', `written ${w} ≠ calculated ${calc}`);
    S.issues.push(`${name}: written ${w} ≠ calculated ${calc}`);
    // suggestion search: one cell whose alternative (or a fill for an unreadable cell) closes the gap
    const cands = [];
    for (const k of keysList) {
      const f = F[k];
      if (f.excluded) continue;
      const cur = f.value ?? 0;
      for (const cv of candidateValues(f)) {
        if (cv.value - cur === diff && cv.value !== f.value) cands.push({ k, value: cv.value, score: cv.p + (f.conf < 0.9 ? 0.2 : 0) });
      }
      if (f.invalid && f.value == null) {
        const lim = LIMITS[f.kind];
        if (diff >= 0 && diff <= lim.max && !cands.some(c => c.k === k && c.value === diff)) cands.push({ k, value: diff, score: 0.35 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands.length) {
      const best = cands[0];
      const f = F[best.k];
      f.suggestion = { value: best.value, reason: `${best.value} would balance the ${name} total (written ${w}, calculated ${calc})`, others: cands.slice(1, 3) };
      if (!f.flags.some(x => x.level === 'red')) addFlag(f, 'red', `doubtful — ${best.value} would balance ${name}`);
    } else {
      // maybe the written total itself is the misread
      const tv = candidateValues(F[wKey]).find(x => x.value === calc);
      if (tv) F[wKey].suggestion = { value: calc, reason: `the written ${name} total may read ${calc}` };
    }
  };
  section(PART_A, 'totalA', calcA, 'Part A');
  section(PART_B, 'totalB', calcB, 'Part B');

  if (g != null && c != null && g !== c) { addFlag(F.grand, 'red', `grand total ${g} ≠ CO total ${c}`); addFlag(F.coTotal, 'red', `CO total ${c} ≠ grand total ${g}`); S.issues.push(`grand ${g} ≠ CO ${c}`); }
  if (S.writtenSum != null) {
    for (const [k, v] of [['grand', g], ['coTotal', c]]) {
      if (v != null && v !== S.writtenSum) { addFlag(F[k], 'red', `${v} ≠ written A + B (${S.writtenSum})`); S.issues.push(`${k}: ${v} ≠ written A+B ${S.writtenSum}`); }
    }
  }
  for (const [k, v] of [['grand', g], ['coTotal', c]]) {
    if (v == null) { addFlag(F[k], 'red', 'missing'); }
    else if (v !== S.calcTotal) addFlag(F[k], 'amber', `calculated A + B = ${S.calcTotal}`);
  }
  // register
  const regKeys = keys.filter(k => k.startsWith('reg')).sort((a, b) => +a.slice(3) - +b.slice(3));
  S.register = regKeys.map(k => F[k].value ?? '_').join('');
  S.registerOk = /^2116\d{9}$/.test(S.register);
  if (!S.registerOk) S.issues.push('register number incomplete');
  S.red = keys.reduce((n, k) => n + F[k].flags.filter(x => x.level === 'red').length, 0);
  rec.summary = S;
  return S;
}
