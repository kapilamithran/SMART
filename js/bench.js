// On-device benchmark: cold load, steady-frame→review latency, recognition errors, photo test, backend comparison.
import { boot, loadOrt, webgpuAvailable } from './runtime.js';
import { recognizeFrame } from './scan.js';
import { parseMark } from './rules.js';
import { Recognizer } from './ocr.js';
import { db } from './db.js';
const $ = s => document.querySelector(s), B = $('#b');
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const report = { device: null, coldLoad: [], latency: {}, recognition: {}, photoTest: [], backends: [] };

function section(title, ...nodes) { const d = document.createElement('div'); d.className = 'card'; d.innerHTML = `<h3>${title}</h3>`; nodes.forEach(n => d.append(n)); B.append(d); return d; }
function html(s) { const d = document.createElement('div'); d.innerHTML = s; return d; }

const rt = await boot({ backend: await db.setting('backend', 'wasm') }, m => $('#st').textContent = m);
$('#st').remove();
report.device = rt.info; db.metric('coldLoad', rt.info);
const i = rt.info;
section('This device', html(`<div class="meta">${i.ua}</div><div class="kpi" style="margin-top:8px">
 <div><small>Browser</small><div class="big">${i.brave ? 'Brave' : /Chrome/.test(i.ua) ? 'Chrome' : 'Other'}</div></div>
 <div><small>Backend</small><div class="big">${i.backend}</div></div><div><small>Threads</small><div class="big">${i.threads}</div></div>
 <div><small>Cold load now</small><div class="big">${i.coldLoadMs} ms</div><small>${i.swControlled ? 'from offline cache' : 'first visit (network)'}</small></div></div>
 <div class="meta" style="margin-top:6px">parts (ms since start): ${Object.entries(i.parts).map(([k, v]) => k + ' ' + v).join(' · ')}</div>`));

const metrics = await db.all('metrics');
const cold = metrics.filter(m => m.type === 'coldLoad'); report.coldLoad = cold.map(c => ({ at: c.at, ms: c.coldLoadMs, cached: c.swControlled, backend: c.backend }));
const cc = cold.filter(c => c.swControlled).map(c => c.coldLoadMs), cn = cold.filter(c => !c.swControlled).map(c => c.coldLoadMs);
section('Cold load history', html(`<div class="kpi"><div><small>Cached median</small><div class="big">${pct(cc, .5) ?? '—'} ms</div><small>${cc.length} loads</small></div>
 <div><small>First-visit median</small><div class="big">${pct(cn, .5) ?? '—'} ms</div><small>${cn.length} loads</small></div></div>`));

const lat = metrics.filter(m => m.type === 'latency');
const lc = lat.filter(l => l.source !== 'gallery').map(l => l.ms), lp = lat.map(l => l.processingMs ?? l.ms);
report.latency = { camera: { n: lc.length, p50: pct(lc, .5), p90: pct(lc, .9), max: lc.length ? Math.max(...lc) : null, under800: lc.length ? lc.filter(x => x < 800).length / lc.length : null }, processing: { n: lp.length, p50: pct(lp, .5), p90: pct(lp, .9), under800: lp.length ? lp.filter(x => x < 800).length / lp.length : null } };
const avg = k => lat.length ? Math.round(lat.reduce((s, l) => s + (l.breakdown?.[k] || 0), 0) / lat.length) : '—';
section('Photo tap → editable review (camera)', html(`<div class="kpi"><div><small>Median</small><div class="big">${report.latency.camera.p50 ?? '—'} ms</div></div>
 <div><small>90th percentile</small><div class="big">${report.latency.camera.p90 ?? '—'} ms</div></div>
 <div><small>Under 800 ms</small><div class="big">${report.latency.camera.under800 == null ? '—' : Math.round(report.latency.camera.under800 * 100) + '%'}</div><small>${lc.length} captures</small></div></div>
 <div class="meta" style="margin-top:6px">reading only (photo in hand → review): median ${report.latency.processing.p50 ?? '—'} ms · p90 ${report.latency.processing.p90 ?? '—'} ms · under 800 ms ${report.latency.processing.under800 == null ? '—' : Math.round(report.latency.processing.under800 * 100) + '%'}</div><div class="meta" style="margin-top:6px">average breakdown: detect ${avg('detect')} · table ${avg('table')} · register/totals ${avg('others')} · OCR ${avg('ocr')} ms</div>`));

// recognition errors = fields the reviewer changed (OCR value vs saved value)
const recs = await db.all('records'); const byKind = {};
let fields = 0, wrong = 0, flaggedWrong = 0;
const kindOf = k => /^Q/.test(k) ? 'Part A' : /^1[1-5]/.test(k) ? 'Part B' : /^reg/.test(k) ? 'Register' : 'Totals';
for (const r of recs) for (const [k, f] of Object.entries(r.fields)) {
  if (f.fixed) continue;
  const ocrV = parseMark(r.ocrSnapshot?.[k]?.raw ?? '', k).value ?? null, fin = f.value ?? null;
  const kd = kindOf(k); byKind[kd] = byKind[kd] || { n: 0, wrong: 0, flagged: 0 }; byKind[kd].n++; fields++;
  const autoFilled = !!f.autoFilled && !f.edited;
  if (ocrV !== fin && !autoFilled) { wrong++; byKind[kd].wrong++; if ((f.flags || []).length || f.appliedSuggestion || (r.ocrSnapshot?.[k]?.conf ?? 1) < 0.85) { flaggedWrong++; byKind[kd].flagged++; } }
}
report.recognition = { records: recs.length, fields, wrong, flaggedWrong, byKind };
section('Recognition errors (from reviewer corrections)', html(`<p class="meta">Every field a reviewer changed counts as an OCR error. Review all red boxes carefully so this stays honest.</p>
 <table><tr><th>Field type</th><th>Fields</th><th>Errors</th><th>Error rate</th><th>Errors that were flagged</th></tr>
 ${Object.entries(byKind).map(([k, v]) => `<tr><td>${k}</td><td>${v.n}</td><td>${v.wrong}</td><td>${(v.wrong / v.n * 100).toFixed(1)}%</td><td>${v.wrong ? Math.round(v.flagged / v.wrong * 100) + '%' : '—'}</td></tr>`).join('')}
 <tr><th>All</th><th>${fields}</th><th>${wrong}</th><th>${fields ? (wrong / fields * 100).toFixed(1) + '%' : '—'}</th><th>${wrong ? Math.round(flaggedWrong / wrong * 100) + '%' : '—'}</th></tr></table>`));

// photo test
const pt = section('Photo test (representative booklet photos)', html(`<p class="meta">Pick booklet photos. Optionally add a ground-truth .json with the same file name (see docs/BENCHMARK.md) to score errors. Each photo runs 3 times; the first run is discarded as warm-up.</p>
 <input type="file" id="pf" multiple accept="image/*,.json"><div id="pr"></div>`));
$('#pf').onchange = async e => {
  const files = [...e.target.files], gts = {};
  for (const f of files.filter(f => f.name.endsWith('.json'))) gts[f.name.replace(/\.json$/, '')] = JSON.parse(await f.text());
  const out = $('#pr'); out.innerHTML = '<table id="pt"><tr><th>Photo</th><th>median ms</th><th>OCR ms</th><th>errors</th></tr></table>';
  for (const f of files.filter(f => !f.name.endsWith('.json'))) {
    const bmp = await createImageBitmap(f), sc = Math.min(1, 2600 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * sc), Math.round(bmp.height * sc)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const src = rt.cv.matFromImageData(c.getContext('2d').getImageData(0, 0, c.width, c.height));
    const det = rt.pipe.detectPhoto(src);
    if (!det) { $('#pt').insertAdjacentHTML('beforeend', `<tr><td>${f.name}</td><td colspan=3>table not found</td></tr>`); src.delete(); continue; }
    const times = []; let rec;
    for (let k = 0; k < 3; k++) { const t = performance.now(); rec = (await recognizeFrame({ pipe: rt.pipe, rec: rt.rec, src, det })).record; if (k) times.push(performance.now() - t); }
    src.delete();
    const gt = gts[f.name.replace(/\.\w+$/, '')]; let errs = '—', list = [];
    if (gt) { list = Object.entries(gt).filter(([k, v]) => String(rec.fields[k]?.value ?? '') !== String(v)).map(([k, v]) => `${k}:${rec.fields[k]?.text || '·'}≠${v}`); errs = `${list.length}/${Object.keys(gt).length}`; }
    const row = { photo: f.name, medianMs: Math.round(pct(times, .5)), ocrMs: Math.round(rec.timings.ocr), crops: rec.timings.crops, errors: errs, detail: list };
    report.photoTest.push(row);
    $('#pt').insertAdjacentHTML('beforeend', `<tr><td>${f.name}</td><td>${row.medianMs}</td><td>${row.ocrMs}</td><td title="${list.join(' ')}">${errs}</td></tr>`);
  }
};

// backend comparison on a synthetic 26-crop workload
const bc = section('Backend comparison', html(`<p class="meta">Loads the model on each backend and times a typical capture workload (19 single-digit + 7 two-digit crops).</p><button class="secondary" id="bb">Run</button><div id="bo"></div>`));
$('#bb').onclick = async () => {
  const labels = (await (await fetch('models/ppocrv5_mobile_rec_digits.labels.json')).json()).labels; $('#bo').textContent = 'running…';
  const rows = [];
  for (const be of ['wasm', 'webgpu']) {
    if (be === 'webgpu' && !(await webgpuAvailable())) { rows.push({ backend: be, note: 'not available (runtime not deployed or no GPU)' }); continue; }
    try {
      const ort = await loadOrt(be); const t = performance.now();
      const r = await Recognizer.create(ort, { modelUrl: 'models/ppocrv5_mobile_rec_digits.onnx', labels, backend: be, threads: rt.info.threads });
      const load = performance.now() - t; await r.warmup([[19, 48], [7, 96]]);
      const ts = []; for (let k = 0; k < 5; k++) { const t1 = performance.now(); await r.warmup([[19, 48], [7, 96]]); ts.push(performance.now() - t1); }
      rows.push({ backend: be, loadMs: Math.round(load), inferMedianMs: Math.round(pct(ts, .5)) });
    } catch (e) { rows.push({ backend: be, note: e.message }); }
  }
  report.backends = rows;
  $('#bo').innerHTML = `<table><tr><th>Backend</th><th>Model load</th><th>Inference (26 crops)</th></tr>${rows.map(r => `<tr><td>${r.backend}</td><td>${r.loadMs ?? '—'}</td><td>${r.inferMedianMs ?? r.note}</td></tr>`).join('')}</table>`;
};

section('Report', html(`<div class="row"><button class="primary" id="dj">Download report (JSON)</button><button class="secondary" id="dc">Latency log (CSV)</button></div>`));
const dl = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); };
$('#dj').onclick = () => dl(new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 1)], { type: 'application/json' }), `benchmark_${Date.now()}.json`);
$('#dc').onclick = () => dl(new Blob(['at,source,ms,processingMs,detect,table,others,ocr,crops,backend,threads\n' + lat.map(l => [l.at, l.source, l.ms, l.processingMs ?? '', ...['detect', 'table', 'others', 'ocr', 'crops'].map(k => Math.round(l.breakdown?.[k] ?? 0)), l.backend, l.threads].join(',')).join('\n')], { type: 'text/csv' }), `latency_${Date.now()}.csv`);
