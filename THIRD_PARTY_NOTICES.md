# Third-party components (all bundled, no CDN, no server)

| Component | Version | Licence | Location |
|---|---|---|---|
| PaddleOCR PP-OCRv5 Mobile recognition model (ONNX via onnxocr) | PP-OCRv5 / onnxocr 3.1.0 | Apache-2.0 | `models/`, `models/licenses/` |
| ONNX Runtime Web | 1.30.0 | MIT | `vendor/ort/` |
| OpenCV.js (@techstark/opencv-js build) | 5.0.0-release.1 | Apache-2.0 | `vendor/opencv/` |
| jsPDF | 4.2.1 | MIT | `vendor/jspdf/` |
| JSZip | 3.10.2 | MIT (dual MIT/GPLv3, used under MIT) | `vendor/jszip/` |

The trimmed recognition model is a modified version of the PaddleOCR model; the modification is described in `models/MODEL_CARD.md`.
