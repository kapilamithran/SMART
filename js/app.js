// SMART — Scan, Mark, Audit, Review & Total. App controller.
import { boot, webgpuAvailable } from './runtime.js';
import { Camera, QUALITY, pageHash, hamming } from './camera.js';
import { recognizeFrame } from './scan.js';
import { evaluate } from './rules.js';
import { PART_A, PART_B, FIELD_LABEL } from './template.js';
import { db } from './db.js';
import { exportJSON, exportCSV, exportPDF, download } from './export.js';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v != null) e.setAttribute(k, v); } kids.flat().forEach(c => c != null && e.append(c.nodeType ? c : document.createTextNode(c))); return e; };
const S = { rt: null, cam: null, batch: null, records: [], current: null, queue: [], settings: {}, busy: false };

// ---------------------------------------------------------------- boot
(async function main() {
  S.settings = {
    saveImages: await db.setting('saveImages', true),
    backend: await db.setting('backend', 'wasm'),
    autoCapture: await db.setting('autoCapture', false),
    verifyPrefix: await db.setting('verifyPrefix', false),
    minSharp: await db.setting('minSharp', QUALITY.minSharp),
  };
  QUALITY.minSharp = S.settings.minSharp;
  wire();
  try {
    S.rt = await boot({ backend: S.settings.backend }, m => { $('#emptyText').textContent = m; });
  } catch (e) { $('#emptyTitle').textContent = 'Could not start'; $('#emptyText').textContent = e.message; console.error(e); return; }
  db.metric('coldLoad', S.rt.info);
  $('#engineInfo').textContent = `PP-OCRv5 Mobile · ${S.rt.info.backend} · ${S.rt.info.threads} thread(s) · ready in ${(S.rt.info.coldLoadMs / 1000).toFixed(1)} s`;
  const bid = await db.setting('currentBatch', null);
  S.batch = bid ? await db.get('batches', bid) : null;
  if (!S.batch) await newBatch(true);
  await loadRecords();
  $('#emptyTitle').textContent = 'Bring the cover into view';
  $('#emptyText').textContent = 'Include the register number, the complete marks table and the grand-total box.';
  $('#startCamBtn').hidden = false; $('#shutterBtn').disabled = false;
  setStatus('○', 'Ready when you are', 'Enable the camera, or tap Take photo to use the phone camera app.');
  updateMode();
})();

function wire() {
  $('#startCamBtn').onclick = startCamera;
  $('#shutterBtn').onclick = () => takePhoto('photo');
  $('#fileIn').onchange = e => { S.queue.push(...[...e.target.files].map(f => ({ file: f, source: 'gallery' }))); e.target.value = ''; nextFromQueue(); };
  $('#nativeCam').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) { S.queue.push({ file: f, source: 'photo', t0: S.nativeT0 }); nextFromQueue(); } };
  $('#settingsBtn').onclick = openSettings;
  $('#saveBtn').onclick = saveCurrent;
  $('#retakeBtn').onclick = () => closeReview(true);
  $('#newBatchBtn').onclick = async () => { await newBatch(); };
  $('#finishBtn').onclick = finishBatch;
  $('#batchSelect').onchange = async e => { S.batch = await db.get('batches', e.target.value); await db.setSetting('currentBatch', S.batch.id); await loadRecords(); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => { b.closest('.sheet').classList.add('hidden'); resumeCamera(); });
  if (window.visualViewport) {
    const fix = () => { const vv = visualViewport, off = Math.max(0, innerHeight - vv.height - vv.offsetTop); document.querySelectorAll('.footer').forEach(f => f.style.bottom = off + 'px'); };
    visualViewport.addEventListener('resize', fix); visualViewport.addEventListener('scroll', fix);
  }
}
function updateMode() { $('#modePill').textContent = S.settings.autoCapture ? 'AUTO CAPTURE' : 'PHOTO CAPTURE'; if (S.cam) S.cam.autoCapture = S.settings.autoCapture; }
function setStatus(icon, title, detail) { $('#statusIcon').textContent = icon; $('#status').textContent = title; if (detail != null) $('#statusDetail').textContent = detail; }

// ---------------------------------------------------------------- camera (live view = guidance)
async function startCamera() {
  const { cv, pipe } = S.rt;
  S.cam = S.cam || new Camera({
    cv, pipe, video: $('#video'), overlay: $('#overlay'),
    onStatus: onLive, onSteady: () => takePhoto('auto'),
    getKnownHashes: () => knownHashes(),
  });
  updateMode();
  try {
    await S.cam.start();
    $('#cameraEmpty').hidden = true; $('#liveBadge').hidden = false;
  } catch (e) {
    console.warn(e); $('#emptyTitle').textContent = 'Camera preview unavailable';
    $('#emptyText').textContent = 'Tap Take photo to use the phone camera app, or upload photos.';
  }
}
function onLive(st) {
  $('#liveBadge').textContent = st.msg;
  const q = st.q, mark = (id, ok, label) => { const e = $(id); e.textContent = `${label} ${ok == null ? '—' : ok ? '✓' : '✕'}`; e.className = ok == null ? '' : ok ? 'good' : 'bad'; };
  mark('#qForm', st.state === 'search' ? false : true, 'Form');
  mark('#qFrame', q ? q.inFrame : null, 'Cover');
  mark('#qLight', q ? q.mean >= QUALITY.minMean && q.mean <= QUALITY.maxMean && q.glare <= QUALITY.maxGlare : null, 'Light');
  mark('#qFocus', q ? q.sharp >= QUALITY.minSharp : null, 'Focus');
  const icon = { search: '○', bad: '◐', ready: '●', hold: '◑', capture: '◉', dup: '⚠', done: '✓' }[st.state] || '○';
  setStatus(icon, st.msg, st.state === 'ready' ? 'Tap Take photo. A full-resolution photo is read, not the preview.' : st.state === 'search' ? 'Include the register number, the marks table and the grand-total box.' : null);
}
function knownHashes() { return S.records.filter(r => r.hash).map(r => ({ hash: r.hash, label: r.summary?.register || 'saved' })); }
function resumeCamera() { if (!S.current && !S.busy && S.cam && !S.queue.length && $('#review').classList.contains('hidden')) { S.cam.rearm(); S.cam.start(); } }

// ---------------------------------------------------------------- photo capture
async function takePhoto(source) {
  if (S.busy || S.current) return;
  const t0 = performance.now();
  if (!S.cam?.stream) { S.nativeT0 = t0; $('#nativeCam').click(); return; }  // phone camera app
  S.busy = true; showBusy('Taking photo…');
  try {
    const shot = await S.cam.takePhoto();
    S.busy = false;
    await processImage(shot.blob || shot.canvas, t0, source, shot.via);
  } catch (e) { S.busy = false; hideBusy(); console.error(e); toast('Could not take photo: ' + e.message); resumeCamera(); }
}

async function nextFromQueue() {
  if (S.current || S.busy) return;
  const item = S.queue.shift(); if (!item) return resumeCamera();
  await processImage(item.file, item.t0 ?? performance.now(), item.source, 'file', item.file.name);
}

async function processImage(input, t0, source, via, name = '') {
  S.cam?.stop(); S.busy = true; showBusy('Reading marks…');
  let src = null;
  try {
    let canvas;
    if (input instanceof HTMLCanvasElement) canvas = input;
    else {
      const bmp = await createImageBitmap(input, { imageOrientation: 'from-image' });
      const sc = Math.min(1, 3200 / Math.max(bmp.width, bmp.height));
      canvas = document.createElement('canvas'); canvas.width = Math.round(bmp.width * sc); canvas.height = Math.round(bmp.height * sc);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height); bmp.close?.();
    }
    src = S.rt.cv.matFromImageData(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height));
    const det = S.rt.pipe.detectPhoto(src);
    if (!det) throw new Error(`${name ? name + ': ' : ''}booklet marks table not found — include the whole cover, flat and well lit`);
    const hash = pageHash(S.rt.pipe, src, det);
    const dup = knownHashes().find(k => hamming(hash, k.hash) < 0.08);
    if (dup) {
      hideBusy();
      const v = await modal('Already scanned?', `This page looks like the booklet already saved as ${dup.label}. Read it anyway?`, [{ t: 'Skip' }, { t: 'Read anyway', v: 1, primary: true }]);
      if (v !== 1) throw new Error('skipped duplicate page');
      showBusy('Reading marks…');
    }
    const { pipe, rec } = S.rt;
    const { record, cells, H } = await recognizeFrame({ pipe, rec, src, det, verifyPrefix: S.settings.verifyPrefix });
    record.hash = hash; record.source = source; record.capturedVia = via; record.batchId = S.batch.id; record.photoPx = [canvas.width, canvas.height];
    record.thumbs = Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, cellURL(c)]));
    const rv = pipe.rectified(src, H, 0.32); record.preview = matURL(rv); rv.delete();
    S.current = { record, canvas, isNew: true };
    hideBusy(); S.busy = false;
    renderReview();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ms = Math.round(performance.now() - t0);
    record.timings.toReview = ms;
    $('#revMeta').textContent = `${source === 'gallery' ? 'photo' : 'tap'} → review ${ms} ms · reading ${Math.round(record.timings.total)} ms`;
    db.metric('latency', { source, via, ms, processingMs: Math.round(record.timings.total), breakdown: record.timings, backend: S.rt.info.backend, threads: S.rt.info.threads, photoPx: record.photoPx });
    S.current.imageBlob = S.settings.saveImages ? await canvasJPEG(canvas, 1800, 0.82) : null;
  } catch (e) {
    console.warn(e); hideBusy(); S.busy = false; S.current = null;
    if (e.message !== 'skipped duplicate page') { toast(e.message || 'Could not read this booklet'); setStatus('◐', 'Could not read that photo', e.message); }
    nextFromQueue();
  } finally { src?.delete(); }
}
function showBusy(t) { $('#busy').textContent = t; $('#busy').hidden = false; $('#cameraEmpty').hidden = true; }
function hideBusy() { $('#busy').hidden = true; if (!S.cam?.stream) $('#cameraEmpty').hidden = false; }

// ---------------------------------------------------------------- batches & records
async function newBatch(first = false) {
  const def = `Batch ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const name = await ask(first ? 'Name your batch' : 'New batch', 'Keep each class or assessment together.', def);
  if (name == null && !first) return;
  const b = { id: crypto.randomUUID(), name: (name || def).trim(), createdAt: new Date().toISOString() };
  await db.put('batches', b); await db.setSetting('currentBatch', b.id);
  S.batch = b; await loadRecords();
}
async function loadRecords() {
  S.records = (await db.byIndex('records', 'batchId', S.batch.id)).sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1));
  const batches = (await db.all('batches')).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  $('#batchSelect').replaceChildren(...batches.map(b => { const o = el('option', { value: b.id }, b.name + (b.finishedAt ? ' · finished' : '')); if (b.id === S.batch.id) o.selected = true; return o; }));
  $('#count').textContent = S.records.length;
  $('#batchState').textContent = S.batch.finishedAt ? 'FINISHED' : 'LOCAL';
  const list = $('#recordList'); list.replaceChildren();
  if (!S.records.length) list.append(el('p', { class: 'empty' }, 'Your reviewed records will appear here.'));
  for (const r of [...S.records].reverse()) {
    const red = r.summary?.red || 0;
    list.append(el('button', { class: 'record', onclick: () => editRecord(r) },
      el('span', {}, el('span', { class: 'reg' }, r.summary?.register || '—'),
        el('small', {}, `A ${r.fields.totalA.value ?? '—'} · B ${r.fields.totalB.value ?? '—'} · ${r.hasImage ? 'image saved' : 'no image'}`)),
      el('span', { style: 'text-align:right' }, el('strong', {}, r.fields.grand.value ?? '—'),
        el('small', {}, el('span', { class: 'pill ' + (red ? 'red' : '') }, red ? `${red} FLAG${red > 1 ? 'S' : ''}` : 'OK')))));
  }
  renderDownloads();
}

// ---------------------------------------------------------------- review
const ALL = () => [...Array.from({ length: 13 }, (_, i) => `reg${i + 1}`), ...PART_A, ...PART_B, 'totalA', 'totalB', 'grand', 'coTotal'];
const label = k => /^reg/.test(k) ? `Register digit ${k.slice(3)}` : FIELD_LABEL[k] || (/^Q/.test(k) ? `Q${k.slice(1)}` : k);

function renderReview() {
  const { record: r } = S.current, F = r.fields, body = $('#revBody');
  body.innerHTML = '';
  if (r.lowRes) body.append(el('div', { class: 'note warn', style: 'margin-bottom:14px' }, el('strong', {}, 'Low-resolution photo. '), 'The register digits are too small to read reliably — check every red register box, or retake closer.'));
  if (r.preview) body.append(el('div', { class: 'rcard' }, el('img', { class: 'preview', src: r.preview, alt: 'captured booklet' })));
  const cellEl = (k, lab) => {
    const f = F[k];
    const inp = el('input', { value: f.text ?? '', inputmode: f.kind === 'reg' ? 'numeric' : 'tel', autocomplete: 'off', maxlength: f.kind === 'reg' ? 1 : 6, 'aria-label': label(k) });
    if (f.fixed) inp.readOnly = true;
    inp.addEventListener('input', () => onEdit(k, inp));
    inp.addEventListener('focus', () => inp.select());
    const c = el('div', { class: 'cell', 'data-k': k }, el('label', {}, lab, el('span', { class: 'cf' })), r.thumbs?.[k] ? el('img', { src: r.thumbs[k], alt: '' }) : null, inp);
    if (f.fixed) c.classList.add('fixed');
    c.querySelector('img')?.addEventListener('click', () => explain(k));
    c.querySelector('label').addEventListener('click', () => explain(k));
    return c;
  };
  body.append(el('div', { class: 'rcard' }, el('h3', {}, 'Register number', el('span', { id: 'regStr' })), el('div', { class: 'reg' }, Array.from({ length: 13 }, (_, i) => cellEl(`reg${i + 1}`, String(i + 1))))));
  body.append(el('div', { class: 'rcard' }, el('h3', {}, 'Part A', el('small', { class: 'meta' }, '0, 1 or 2')), el('div', { class: 'grid' }, PART_A.map(k => cellEl(k, k.slice(1))))));
  body.append(el('div', { class: 'rcard' }, el('h3', {}, 'Part B', el('small', { class: 'meta' }, '0–11 · one of a/b')), el('div', { class: 'grid' }, PART_B.map(k => cellEl(k, k)))));
  body.append(el('div', { class: 'rcard' }, el('h3', {}, 'Totals'), el('div', { class: 'totals' }, ['totalA', 'totalB', 'grand', 'coTotal'].map(k => cellEl(k, FIELD_LABEL[k]))), el('div', { class: 'calc', id: 'calc' })));
  body.append(el('div', { class: 'rcard' }, el('h3', {}, 'Check before saving'), el('ul', { class: 'issues', id: 'issues' })));
  if (!S.current.isNew) body.append(el('div', { class: 'row', style: 'justify-content:flex-start' }, el('button', { class: 'secondary danger', onclick: deleteCurrent }, 'Delete this record')));
  body.append(el('p', { class: 'meta', id: 'timing' }));
  $('#review').classList.remove('hidden');
  refreshReview(); body.scrollTop = 0;
}
function onEdit(k, inp) {
  const f = S.current.record.fields[k];
  f.text = inp.value.trim(); f.edited = f.text !== (f.raw ?? '') || !!f.autoFilled;
  if (f.kind === 'reg' && /^\d$/.test(f.text)) { const nx = document.querySelector(`[data-k="reg${+k.slice(3) + 1}"] input`); nx && !nx.readOnly && nx.focus(); }
  refreshReview();
}
function refreshReview() {
  const r = S.current.record, F = r.fields, s = evaluate(r);
  for (const k of ALL()) {
    const c = document.querySelector(`.cell[data-k="${k}"]`); if (!c) continue;
    const f = F[k], red = (f.flags || []).some(x => x.level === 'red');
    c.classList.toggle('flag', red);
    c.classList.toggle('amber', !red && !!f.flags?.some(x => x.level === 'amber'));
    c.classList.toggle('info', !red && !!f.flags?.some(x => x.level === 'info'));
    c.classList.toggle('excluded', !!f.excluded); c.classList.toggle('suggest', !!f.suggestion);
    c.querySelector('.cf').textContent = f.fromOcr && !f.edited && f.text ? Math.round((f.conf ?? 1) * 100) + '%' : (f.edited ? 'edited' : '');
    const inp = c.querySelector('input'); if (document.activeElement !== inp && inp.value !== (f.text ?? '')) inp.value = f.text ?? '';
  }
  $('#regStr').textContent = s.register;
  const box = (lab, v, bad) => el('div', { class: bad ? 'bad' : '' }, el('small', {}, lab), el('b', {}, v ?? '—'));
  $('#calc').replaceChildren(box('Part A calculated', s.calcA + (s.incA ? '?' : ''), s.writtenA != null && s.calcA !== s.writtenA),
    box('Part B calculated', s.calcB + (s.incB ? '?' : ''), s.writtenB != null && s.calcB !== s.writtenB),
    box('A + B calculated', s.calcTotal, s.grand != null && s.calcTotal !== s.grand));
  const ul = $('#issues'); ul.replaceChildren();
  for (const k of ALL()) { const sg = F[k].suggestion; if (sg) ul.append(el('li', { class: 'red' }, el('span', { class: 'why' }, `${label(k)}: ${sg.reason}`), el('button', { class: 'apply', onclick: () => applySuggestion(k) }, `Set ${sg.value}`))); }
  const rank = { red: 0, amber: 1, info: 2 };
  const items = ALL().flatMap(k => (F[k].flags || []).map(fl => ({ k, fl }))).sort((a, b) => rank[a.fl.level] - rank[b.fl.level]);
  for (const { k, fl } of items) ul.append(el('li', { class: fl.level }, el('span', { class: 'why' }, `${label(k)}: ${fl.msg}`)));
  if (!ul.children.length) ul.append(el('li', { class: 'ok' }, el('span', { class: 'why' }, 'All fields consistent.')));
  const t = r.timings; if (t) $('#timing').textContent = `detect ${t.detect | 0} · table ${t.table | 0} · register/totals ${t.others | 0} · OCR ${t.ocr | 0} ms (${t.crops} crops) · ${S.rt.info.backend}, ${S.rt.info.threads} thread(s)${r.photoPx ? ` · photo ${r.photoPx.join('×')}` : ''}`;
  $('#saveBtn').textContent = (S.current.isNew ? 'OK · Save' : 'OK · Save changes') + (s.red ? ` (${s.red} flagged)` : '');
}
function applySuggestion(k) {
  const f = S.current.record.fields[k], sg = f.suggestion; if (!sg) return;
  f.text = String(sg.value); f.edited = true; f.appliedSuggestion = { value: sg.value, reason: sg.reason };
  refreshReview();
}
function explain(k) {
  const f = S.current.record.fields[k];
  const alts = (f.alts || []).slice(0, 4).map(a => `${a.text || '(blank)'} ${Math.round(a.p * 100)}%`).join(', ');
  const lines = [`Read: "${f.raw || (f.inkBlank ? '— (' + f.inkBlank + ')' : '')}"${f.fromOcr ? ` · confidence ${Math.round((f.conf ?? 1) * 100)}%` : ' · fixed prefix'}`];
  if (alts) lines.push(`Alternatives: ${alts}`);
  if (f.autoFilled) lines.push(`Auto-filled ${f.autoFilled.to} — ${f.autoFilled.why}`);
  (f.flags || []).forEach(x => lines.push('• ' + x.msg));
  modal(label(k), lines.join('\n'), f.suggestion ? [{ t: 'Close' }, { t: `Set ${f.suggestion.value}`, primary: true, v: 1 }] : [{ t: 'Close' }]).then(v => { if (v === 1) applySuggestion(k); });
}
async function saveCurrent() {
  const cur = S.current; if (!cur) return;
  const r = cur.record, s = evaluate(r);
  if (!s.registerOk) { await modal('Register number incomplete', `It reads "${s.register}". It must be 13 digits starting with 2116. Fix the red boxes, then save.`, [{ t: 'Fix it', primary: true }]); return; }
  const dup = S.records.find(x => x.id !== r.id && x.summary?.register === s.register);
  if (dup) {
    const v = await modal('Duplicate register number', `${s.register} is already saved in “${S.batch.name}” (total ${dup.fields.grand.value ?? '—'}). Replacing removes the earlier record.`, [{ t: 'Cancel' }, { t: 'Replace earlier', v: 1, danger: true }]);
    if (v !== 1) return;
    await db.del('records', dup.id); await db.del('images', dup.id);
  }
  if (s.red) { const v = await modal('Save with open flags?', `${s.red} red flag(s) remain. They stay on the record for audit.`, [{ t: 'Review again' }, { t: 'Save', v: 1, primary: true }]); if (v !== 1) return; }
  r.savedAt = new Date().toISOString(); r.batchId = S.batch.id;
  if (cur.isNew) { r.hasImage = !!cur.imageBlob; if (cur.imageBlob) await db.put('images', { id: r.id, blob: cur.imageBlob }); }
  await db.put('records', JSON.parse(JSON.stringify(r)));
  await loadRecords(); toast(`Saved ${s.register}`); closeReview(false);
  setStatus('✓', `Saved ${s.register}`, 'Show the next booklet and tap Take photo.');
}
async function deleteCurrent() {
  const r = S.current.record;
  if (await modal('Delete record?', `Delete ${r.summary?.register}? This cannot be undone.`, [{ t: 'Cancel' }, { t: 'Delete', v: 1, danger: true }]) !== 1) return;
  await db.del('records', r.id); await db.del('images', r.id); await loadRecords(); closeReview(false);
}
function closeReview() { $('#review').classList.add('hidden'); S.current = null; if (S.queue.length) nextFromQueue(); else resumeCamera(); }
function editRecord(r) { S.cam?.stop(); S.current = { record: JSON.parse(JSON.stringify(r)), isNew: false }; renderReview(); $('#revMeta').textContent = 'editing saved record'; }

// ---------------------------------------------------------------- finish & export
async function finishBatch() {
  if (!S.records.length) return toast('Nothing to finish yet');
  if (S.batch.finishedAt) return $('#downloads').scrollIntoView({ behavior: 'smooth' });
  const red = S.records.filter(r => r.summary?.red).length;
  if (await modal('Finish batch? (1 of 2)', `“${S.batch.name}” has ${S.records.length} record(s)${red ? `, ${red} still carrying red flags` : ''}. Downloads unlock after finishing.`, [{ t: 'Cancel' }, { t: 'Continue', v: 1, primary: true }]) !== 1) return;
  if (await modal('Confirm finish (2 of 2)', `Please confirm once more: finish “${S.batch.name}” and prepare downloads?`, [{ t: 'Go back' }, { t: 'Yes, finish', v: 1, primary: true }]) !== 1) return;
  S.batch.finishedAt = new Date().toISOString(); await db.put('batches', S.batch); await loadRecords();
  $('#downloads').scrollIntoView({ behavior: 'smooth' });
}
function renderDownloads() {
  const d = $('#downloads'); d.replaceChildren(); d.hidden = !S.batch.finishedAt; if (d.hidden) return;
  const noImg = S.records.filter(r => !r.hasImage);
  const cb = el('input', { type: 'checkbox', id: 'incImg' }); cb.checked = true;
  const help = el('p', { class: 'small' });
  const upd = () => help.textContent = cb.checked ? 'JSON and PDF embed each saved scan image. CSV downloads as a ZIP: the CSV plus an images folder, with each row’s image linked in its last cell.' : 'Downloads contain marks only — no images in any file.';
  cb.onchange = upd; upd();
  d.append(el('p', {}, 'Batch finished. Download your records.'), el('label', { class: 'check' }, cb, el('span', {}, el('b', {}, 'Include captured images'))), help);
  if (noImg.length) d.append(el('div', { class: 'note warn' }, `${noImg.length} record(s) (${noImg.map(r => r.summary?.register).slice(0, 4).join(', ')}${noImg.length > 4 ? '…' : ''}) were saved without an image — older records or image saving switched off — so they cannot supply one. Their exports say “no saved image”.`));
  const go = async kind => {
    const inc = cb.checked, images = new Map();
    if (inc) for (const r of S.records) { const im = r.hasImage ? await db.get('images', r.id) : null; if (im) images.set(r.id, im.blob); }
    const base = S.batch.name.replace(/[^\w-]+/g, '_'); toast('Preparing ' + kind.toUpperCase() + '…');
    if (kind === 'json') download(await exportJSON(S.batch, S.records, images, inc), `${base}.json`);
    if (kind === 'csv') { const { blob, ext } = await exportCSV(S.batch, S.records, images, inc); download(blob, `${base}${inc ? '_with_images' : ''}.${ext}`); }
    if (kind === 'pdf') download(await exportPDF(S.batch, S.records, images, inc), `${base}.pdf`);
  };
  d.append(el('div', { class: 'download-buttons' }, ['csv', 'json', 'pdf'].map(k => el('button', { 'data-export': k, onclick: () => go(k) }, k.toUpperCase()))),
    el('button', { class: 'quiet', onclick: async () => { delete S.batch.finishedAt; await db.put('batches', S.batch); loadRecords(); } }, 'Reopen batch'));
}

// ---------------------------------------------------------------- settings
async function openSettings() {
  S.cam?.stop();
  const b = $('#settingsBody'); b.innerHTML = '';
  const card = el('div', { class: 'rcard' });
  const toggle = (key, title, desc, after) => {
    const i = el('input', { type: 'checkbox' }); i.checked = !!S.settings[key];
    i.onchange = async () => { S.settings[key] = i.checked; await db.setSetting(key, i.checked); after?.(); };
    return el('label', { class: 'check' }, i, el('span', {}, el('b', {}, title), el('br'), el('span', { class: 'small' }, desc)));
  };
  card.append(toggle('saveImages', 'Save captured images', 'Keeps each photo with its record so exports can include it.'),
    toggle('autoCapture', 'Auto-capture when steady', 'Takes the photo automatically once the cover is steady and sharp.', updateMode),
    toggle('verifyPrefix', 'Also read the 2116 prefix', 'Off (faster): the first four boxes are the fixed prefix 2116.'));
  const be = el('select', {}, ['wasm', 'webgpu'].map(v => { const o = el('option', { value: v }, v === 'wasm' ? 'WASM (CPU, recommended)' : 'WebGPU (experimental)'); if (v === S.settings.backend) o.selected = true; return o; }));
  if (!(await webgpuAvailable())) { const o = be.querySelector('[value=webgpu]'); o.disabled = true; o.textContent = 'WebGPU (not installed / not supported)'; }
  be.onchange = async () => { await db.setSetting('backend', be.value); location.reload(); };
  const sh = el('input', { type: 'text', inputmode: 'decimal', value: S.settings.minSharp });
  sh.onchange = async () => { const v = parseFloat(sh.value); if (v > 0) { S.settings.minSharp = QUALITY.minSharp = v; await db.setSetting('minSharp', v); } };
  card.append(el('div', { class: 'field' }, el('b', {}, 'OCR backend'), be), el('div', { class: 'field' }, el('b', {}, 'Focus threshold (lower = more tolerant)'), sh));
  const i = S.rt.info;
  b.append(card, el('div', { class: 'rcard' }, el('h3', {}, 'Engine'), el('p', { class: 'meta' }, `PP-OCRv5 Mobile (local) · ${i.backend} · ${i.threads} thread(s) · cross-origin isolated ${i.crossOriginIsolated} · cold load ${i.coldLoadMs} ms`),
    el('a', { class: 'secondary', href: 'bench.html' }, 'Open benchmark ↗')));
  $('#settings').classList.remove('hidden');
}

// ---------------------------------------------------------------- ui helpers
function modal(title, text, buttons) {
  return new Promise(res => {
    const m = el('div', { class: 'modal' }, el('div', { class: 'box' }, el('h4', {}, title), el('p', { style: 'white-space:pre-line' }, text),
      el('div', { class: 'row' }, buttons.map(b => el('button', { class: b.primary ? 'primary' : b.danger ? 'secondary danger' : 'secondary', onclick: () => { m.remove(); res(b.v); } }, b.t)))));
    document.body.append(m);
  });
}
function ask(title, text, def) {
  return new Promise(res => {
    const inp = el('input', { type: 'text', value: def, maxlength: 80 });
    const m = el('div', { class: 'modal' }, el('div', { class: 'box' }, el('p', { class: 'eyebrow' }, 'NEW MARK ENTRY'), el('h4', {}, title), el('p', {}, text), el('label', { class: 'small' }, 'Batch name'), inp,
      el('button', { class: 'primary', style: 'width:100%', onclick: () => { m.remove(); res(inp.value); } }, 'Create batch')));
    document.body.append(m); inp.focus(); inp.select();
  });
}
let toastT; function toast(msg) { document.querySelector('.toast')?.remove(); const t = el('div', { class: 'toast' }, msg); document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3000); }
function cellURL(c) { const cv = document.createElement('canvas'); cv.width = c.w; cv.height = c.h; cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(c.rgba), c.w, c.h), 0, 0); return cv.toDataURL('image/jpeg', 0.7); }
function matURL(m) { const cv = document.createElement('canvas'); cv.width = m.cols; cv.height = m.rows; cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.data), m.cols, m.rows), 0, 0); return cv.toDataURL('image/jpeg', 0.75); }
function canvasJPEG(src, max, q) { const s = Math.min(1, max / Math.max(src.width, src.height)); const c = document.createElement('canvas'); c.width = Math.round(src.width * s); c.height = Math.round(src.height * s); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return new Promise(r => c.toBlob(r, 'image/jpeg', q)); }
