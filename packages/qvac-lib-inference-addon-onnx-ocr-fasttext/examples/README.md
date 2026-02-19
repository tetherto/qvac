# Examples

## DocTR vs EasyOCR Demo

Side-by-side comparison of the DocTR and EasyOCR pipelines on a lab results image, showing speed and accuracy differences.

### Prerequisites

- Built addon (`npm install && bare-make generate && bare-make build && bare-make install`)
- EasyOCR models in `models/ocr/rec_dyn/` (`detector_craft.onnx`, `recognizer_latin.onnx`)
- DocTR models are auto-downloaded on first run to `test/models/doctr/`
- Python 3 with `opencv-python` and `numpy` (for visualization only)

### Step 1: Run the comparison

```bash
bare examples/demo-compare.js
```

This runs both pipelines on `test/images/lab_results.png` and prints a timing table:

```
────────────────────────────────────────────────────
  DocTR vs EasyOCR Comparison
────────────────────────────────────────────────────
  Metric                        DocTR    EasyOCR
  ──────────────────────── ────────── ──────────
  Total time                    3.21s     39.50s
  Detection time                1.09s     17.14s
  Recognition time              679ms     21.49s
  Text regions                    195        111
  ──────────────────────── ────────── ──────────
  Speedup                       12.3x
────────────────────────────────────────────────────
```

Results are saved as JSON to `test/output/demo_doctr.json` and `test/output/demo_easyocr.json`.

### Step 2: Visualize

```bash
python3 examples/demo-visualize.py
```

Generates:
- `test/output/demo_doctr_bboxes.png` — DocTR bounding boxes (green)
- `test/output/demo_easyocr_bboxes.png` — EasyOCR bounding boxes (blue)
- `test/output/demo_doctr_vs_easyocr.png` — side-by-side comparison

### Why is DocTR faster?

| | DocTR | EasyOCR |
|---|---|---|
| Detector | DBNet + MobileNetV3 (16MB) | CRAFT + VGG (80MB) |
| Recognizer | CRNN + MobileNetV3-small (8MB) | LSTM-based (15MB) |
| Detection approach | Detects whole words directly | Detects individual characters, then groups into words |
| Extra steps | None | Rotation tries, contrast retry, character linking |

DocTR uses lightweight MobileNet backbones and detects word-level regions in a single pass. EasyOCR's CRAFT detector finds individual characters and then merges them using link scores and heuristics — powerful for rotated/curved text, but unnecessary overhead for well-structured documents.

## Other Examples

| File | Description |
|---|---|
| `example.fs.js` | Basic OCR from filesystem |
| `example.hd.js` | OCR with Hyperdrive model loading |
| `exampleGPU.fs.js` | GPU-accelerated OCR |
| `example.logger.js` | OCR with custom logging |
| `visualize_ocr.js` | Run OCR and save results as JSON |
| `draw_boxes.py` | Draw bounding boxes from JSON results |
