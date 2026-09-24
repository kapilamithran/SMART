import { loadCv, loadOrt, readImage } from './node_env.mjs';
import { Pipeline } from '../js/pipeline.js';
import { Recognizer } from '../js/ocr.js';
import { recognizeFrame } from '../js/scan.js';
import fs from 'fs';
const cv = await loadCv(); const ort = await loadOrt();
const labels = JSON.parse(fs.readFileSync(new URL('../models/ppocrv5_mobile_rec_digits.labels.json', import.meta.url))).labels;
const model = fs.readFileSync(new URL('../models/ppocrv5_mobile_rec_digits.onnx', import.meta.url));
const rec = await Recognizer.create(ort, { modelUrl: model, labels, threads: 1 });
await rec.warmup();
const pipe = new Pipeline(cv);
const path = process.argv[2] || new URL('./photos/sample1.png', import.meta.url).pathname;
const src = readImage(cv, path);
let t = performance.now(); const live = pipe.detect(src, 800); const tl = performance.now() - t;
console.log('live detect', tl.toFixed(0), 'ms', live && { cols: live.cols, aspect: live.aspect.toFixed(2) });
console.log('quality', live && pipe.quality(src, live));
for (let run = 0; run < 2; run++) {
  const { record } = await recognizeFrame({ pipe, rec, src, det: live });
  if (run) {
    const F = record.fields;
    const show = ks => ks.map(k => `${k}:${F[k].text || '·'}${F[k].flags.some(f => f.level === 'red') ? '!' : ''}(${(F[k].conf ?? 1).toFixed(2)})`).join(' ');
    console.log('REG ', record.summary.register, record.located);
    console.log('A   ', show(['Q1','Q2','Q3','Q4','Q5','Q6','Q7','Q8','Q9','Q10']));
    console.log('B   ', show(['11a','11b','12a','12b','13a','13b','14a','14b','15a','15b']));
    console.log('TOT ', show(['totalA','totalB','grand','coTotal']));
    console.log('regs', show(['reg5','reg6','reg7','reg8','reg9','reg10','reg11','reg12','reg13']));
    console.log('SUM ', JSON.stringify(record.summary));
    for (const k in F) { if (F[k].suggestion) console.log('SUGGEST', k, F[k].suggestion.value, F[k].suggestion.reason); }
    for (const k in F) for (const f of F[k].flags || []) console.log('  flag', k, f.level, f.msg);
    console.log('timings', JSON.stringify(record.timings, (k, v) => typeof v === 'number' ? +v.toFixed(0) : v));
  }
}
src.delete();
