// Accuracy + timing harness on photos with ground-truth JSON (tests/photos/*.json)
import { loadCv, loadOrt, readImage } from './node_env.mjs';
import { Pipeline } from '../js/pipeline.js';
import { Recognizer } from '../js/ocr.js';
import { recognizeFrame } from '../js/scan.js';
import fs from 'fs';
const cv = await loadCv(); const ort = await loadOrt();
const labels = JSON.parse(fs.readFileSync('../models/ppocrv5_mobile_rec_digits.labels.json')).labels;
let t = performance.now();
const rec = await Recognizer.create(ort, { modelUrl: fs.readFileSync('../models/ppocrv5_mobile_rec_digits.onnx'), labels, threads: 1 });
const wu = await rec.warmup(); console.log('model load', rec.loadMs.toFixed(0), 'ms, warmup', wu.toFixed(0), 'ms');
const pipe = new Pipeline(cv); const SIDE=+(process.env.SIDE||1400), SO=process.env.SO!=='0';
const files = fs.readdirSync('photos').filter(f => /\.(png|jpe?g)$/i.test(f));
const agg = { fields: 0, wrongTop: 0, wrongFinal: 0, flaggedWrong: 0, unflaggedWrong: 0, byKind: {} };
const times = [];
for (const f of files) {
  const gtp = 'photos/' + f.replace(/\.\w+$/, '.json'); if (!fs.existsSync(gtp)) continue;
  const gt = JSON.parse(fs.readFileSync(gtp)); const src = readImage(cv, 'photos/' + f);
  const det = pipe.detect(src, 800);
  await recognizeFrame({ pipe, rec, src, det, refineSide: SIDE, secondOpinion: SO }); // warm
  const { record } = await recognizeFrame({ pipe, rec, src, det, refineSide: SIDE, secondOpinion: SO });
  times.push(record.timings);
  const F = record.fields; const rows = [];
  for (const [k, v] of Object.entries(gt)) {
    const fld = F[k]; const got = fld.value ?? ''; const want = v === '' ? '' : v;
    const kind = fld.kind; agg.byKind[kind] = agg.byKind[kind] || { n: 0, wrong: 0, flaggedWrong: 0 };
    agg.fields++; agg.byKind[kind].n++;
    const ok = String(got) === String(want);
    const flagged = (fld.flags || []).some(x => x.level === 'red');
    if (!ok) { agg.wrongFinal++; agg.byKind[kind].wrong++; if (flagged) { agg.flaggedWrong++; agg.byKind[kind].flaggedWrong++; } else agg.unflaggedWrong++; rows.push(`${k}: got "${fld.text}" want "${want}" ${flagged ? '(flagged)' : '(NOT flagged)'}${fld.suggestion ? ' suggestion=' + fld.suggestion.value : ''}`); }
  }
  console.log(`\n${f}: ${rows.length} wrong`); rows.forEach(r => console.log('  ', r));
  console.log('  summary', JSON.stringify(record.summary));
  src.delete();
}
console.log('\nTOTAL', JSON.stringify(agg));
const avg = k => (times.reduce((s, t) => s + t[k], 0) / times.length).toFixed(0);
console.log('timings avg ms: detect', avg('detect'), 'table', avg('table'), 'others', avg('others'), 'ocr', avg('ocr'), 'second', avg('second'), 'total', avg('total'), 'crops', avg('crops'));
