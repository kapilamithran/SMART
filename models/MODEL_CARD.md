# PP-OCRv5 Mobile — text recognition (digit-trimmed)

| | |
|---|---|
| Original model | PaddleOCR **PP-OCRv5_mobile_rec** (multilingual, 18 383-character dictionary) |
| ONNX source | `onnxocr` 3.1.0 on PyPI — `onnxocr/models/ppocrv5/rec/rec.onnx` (16.6 MB) |
| Licence | Apache-2.0 (PaddleOCR) — see `licenses/` |
| Modification | Final linear classifier (`linear_8`) sliced to 22 classes: CTC blank, 0–9, `+`, `-`, and look-alikes `一 — – _ / \| l I .` which the app maps to `1`, `-` or nothing. Backbone and neck untouched; kept logits are identical to the original (softmax renormalised over kept classes). Script: `tools/trim_model.py`. |
| File | `ppocrv5_mobile_rec_digits.onnx` (7.5 MB), labels in `ppocrv5_mobile_rec_digits.labels.json` |
| Input | `x` float32 [N, 3, 48, W], BGR, (pixel/255 − 0.5)/0.5, right-padded with 0 |
| Output | softmax [N, W/8, 22] — greedy CTC decode |
| Not used | PP-OCRv5 detection model (cell positions come from the printed form, so detection is unnecessary and slower) |
