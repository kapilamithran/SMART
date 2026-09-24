import { loadCv, readImage } from './node_env.mjs';
import { Pipeline } from '../js/pipeline.js';
const cv = await loadCv(); const pipe = new Pipeline(cv);
const src = readImage(cv, process.argv[2] || './photos/live1_frame.png');
// simulate a 1080x1920 portrait camera frame: the crop is ~1182 wide
for (const ms of [800, 1000, 1200, 1400]) {
  const d = pipe.detect(src, ms);
  console.log(ms, d ? { cols: d.cols, aspect: d.aspect.toFixed(2), q: JSON.stringify(pipe.quality(src, d), (k, v) => typeof v === 'number' ? +v.toFixed(2) : v) } : null);
}
// candidate debug at 800
const sc = 800 / Math.max(src.cols, src.rows); const small = new cv.Mat(); cv.resize(src, small, new cv.Size(Math.round(src.cols*sc), Math.round(src.rows*sc)), 0, 0, cv.INTER_AREA);
const [mx] = pipe.maxMin(small); const [h, v] = pipe.lineMasks(mx, 800/45, 800/100, 800/40, 10);
const g = new cv.Mat(); cv.bitwise_or(h, v, g); const cs = new cv.MatVector(), hi = new cv.Mat(); cv.findContours(g, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
const arr=[]; for (let i=0;i<cs.size();i++){const c=cs.get(i),a=cv.contourArea(c); if(a>0.002*small.cols*small.rows){const r=cv.boundingRect(c); arr.push([Math.round(a),r.x,r.y,r.width,r.height,(r.width/r.height).toFixed(2)]);}}
console.log(small.cols, small.rows, arr.sort((a,b)=>b[0]-a[0]).slice(0,6));
