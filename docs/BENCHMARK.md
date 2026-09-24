# Benchmarking

## On your Chrome / Brave phones (the numbers that matter)
1. Deploy (DEPLOY.md), open the app, scan 20+ real booklets and **correct every mistake before saving**. Each correction counts as an OCR error.
2. Open **Settings → Open benchmark** (`bench.html`). It reports:
   - **Cold load** (navigation → model warmed up), split into cached vs first-visit, with the OpenCV/ORT/model/warm-up parts.
   - **Steady frame → editable review** latency: median, p90 and % under 800 ms, with a detect / table / register-totals / OCR breakdown.
   - **Recognition errors** per field type (Part A, Part B, totals, register) and the share of errors that had been flagged red.
   - **Photo test:** pick booklet photos plus optional ground-truth JSONs with the same name, e.g. `IMG_01.json`:
     `{"Q1":2,…,"Q10":2,"11a":8,"11b":"",…,"totalA":18,"totalB":44,"grand":62,"coTotal":62,"reg5":2,…,"reg13":7}`
   - **Backend comparison:** WASM vs WebGPU on a 26-crop workload.
   - **Download report (JSON)** and the latency log (CSV). Run this on each phone and browser, then compare.
3. Tip for speed and accuracy: hold the phone **sideways** so the cover band (register number → grand total) fills the frame.

## Measured so far (development sandbox — NOT a phone)
Environment: 1 CPU core, so ORT ran single-threaded. Input: the one supplied booklet photo (864×1536, i.e. low resolution).

| Measurement | Result |
|---|---|
| Node, same modules, steady-state per frame | detect 83–99 · table 90 · register/totals 130 · OCR 475–550 → **≈ 820 ms** |
| Headless Chrome 141, live fake-camera capture, steady frame → review | **1164 ms** (detect 180 · table 208 · register/totals 261 · OCR 432) |
| Headless Chrome, gallery photo → review | 1224 ms |
| Cold load (cached, headless Chrome) | 2.2 s (OpenCV 0.8 s, model 1.5 s, warm-up 0.6 s) |
| Recognition, 33 fields | Part A **10/10**, totals **4/4**, Part B 9/10 (overwritten 11a flagged, with suggestion 8), register digits **3–5 of 9 wrong** (digits are ~10 px tall in this photo), and 80–100% of errors were flagged red |

Phones have 4–8 cores. With cross-origin isolation, ORT uses up to 4 threads in a worker, and OCR overlaps with the register/totals
extraction, so the sub-800 ms target is plausible on mid-range devices but **not yet proven**. Use bench.html to confirm it.
Things tried that did **not** help: int8 quantisation (no gain in WASM; conv-int8 was slower), horizontal stretching (more errors),
and a second-opinion re-read of doubtful cells (+260 ms, no net accuracy gain; it is still available in `scan.js` as `secondOpinion`).

## Digit CNN comparison
As instructed, the scanner uses PP-OCRv5 Mobile only; no digit-CNN baseline was built or compared.

## Developer harness
```bash
cd tests && npm install
node rules.test.mjs                 # rule unit tests
node acc.mjs                        # accuracy + timing on tests/photos/*.png|jpg with same-name .json ground truth
```
