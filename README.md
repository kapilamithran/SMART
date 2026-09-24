## SMART — Scan, Mark, Audit, Review & Total

**v2.0 capture change:** the live preview now only guides framing (Form / Cover / Light / Focus). **Take photo** grabs a full-resolution still (ImageCapture), or opens the phone camera app when the preview is off, and reads that photo, the same path as Upload. Auto-capture-on-steady is still available in Settings.

# SMART (Scan, Mark, Audit, Review & Total)

Mobile-first answer-booklet mark scanner for **Chrome and Brave on Android**. It reads the cover of the
Rajalakshmi Engineering College Continuous Assessment Test booklet entirely **on the phone** with
**PP-OCRv5 Mobile** (ONNX Runtime Web + OpenCV.js). There is no recognition API and no server: GitHub Pages only serves static files.

## What it reads
- Register number: 13 boxes; the first four are the fixed prefix **2116** (optionally OCR-verified in Settings)
- Part A Q1–Q10: **0, 1 or 2 only**, read as one digit. `1+1` counts as 2. `27` (or any out-of-range reading) is **never** truncated or forced into range; the cell stays empty and red with the raw reading shown.
- Part B 11a/11b … 15a/15b: whole numbers **0–11**; `6+2` counts as 8. Dashes and empty cells stay blank.
- Written Part A total, Part B total, Grand total box and the CO table Total box.

## Rules
- Part A, Part B and overall sums are calculated independently of the written totals.
- **Totals rule:** if the detected grand total **or** CO total equals written A + written B, both total fields are set to that value. The original readings are kept in the audit trail, and the auto-filled field is outlined in cyan.
- Conflicting readings and sums stay flagged (red ring with "!" badge).
- **Balancing is suggestion-only.** When marks do not add up to a written total, the app searches the cells for one whose alternative reading closes the gap exactly (e.g. a doubtful 1-or-2 that makes 60 → 61). It marks that cell red and offers a **Set 2** button. It never changes a value by itself.
- Part B: if both a and b of a question carry marks, the higher is kept and the other is flagged red and excluded from the sum.

## Workflow
Automatic form detection → quality checks (distance, whole cover in view, flatness, light, glare, blur) → capture on a
steady frame → editable review with a crop of every cell → a single **OK · Save** button that stays above the keyboard.
Duplicate protection works at two levels: the page hash blocks re-capturing a booklet already in the batch, and a duplicate register number asks before replacing the earlier record.
Gallery upload runs the same pipeline on photos. Batches are named. **Finish batch** requires two confirmations, then JSON / CSV / PDF downloads.
The **Include captured images** checkbox works as follows:

| | JSON | CSV | PDF |
|---|---|---|---|
| checked | image embedded (base64) per record | ZIP: CSV + `images/`; the last cell of each row is `=HYPERLINK("images/…jpg")` | image page per record |
| unchecked | no images | plain CSV, no image column | no images |

Records saved while "Save captured images" was off (or saved by an older version) have no stored image and **cannot supply one**. The export screen lists them, and their exports say "no saved image".

## Layout
```
index.html  bench.html  sw.js  manifest.webmanifest  .nojekyll
css/app.css
js/  app.js camera.js pipeline.js ocr.js rules.js scan.js template.js runtime.js db.js export.js bench.js coi.js
models/  ppocrv5_mobile_rec_digits.onnx (+labels, MODEL_CARD.md, licenses/)
vendor/  ort/ opencv/ jspdf/ jszip/   (with licences)
tools/trim_model.py   tests/ (Node harness: same modules as the browser)
docs/DEPLOY.md  docs/BENCHMARK.md  THIRD_PARTY_NOTICES.md
```
See **docs/DEPLOY.md** to publish and **docs/BENCHMARK.md** to measure on your phones.
