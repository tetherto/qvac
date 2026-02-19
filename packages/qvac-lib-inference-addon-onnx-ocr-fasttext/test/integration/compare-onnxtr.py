#!/usr/bin/env python3
"""Compare C++ DocTR implementation with Python OnnxTR on the same image and models."""

import json
import time
import os
import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(os.path.dirname(SCRIPT_DIR))

IMAGE_PATH = os.path.join(PKG_DIR, "test/images/lab_results.png")
OUTPUT_DIR = os.path.join(PKG_DIR, "test/output")
CPP_JSON = os.path.join(OUTPUT_DIR, "lab_results_doctr.json")

MODELS_DIR = os.path.join(PKG_DIR, "test/models/doctr")
DET_MODEL = os.path.join(MODELS_DIR, "db_mobilenet_v3_large.onnx")
REC_MODEL = os.path.join(MODELS_DIR, "crnn_mobilenet_v3_small.onnx")


def run_onnxtr():
    """Run OnnxTR Python implementation."""
    from onnxtr.models import ocr_predictor, from_hub
    from onnxtr.io import DocumentFile

    print("Loading OnnxTR models...")
    # Use the same model architectures
    predictor = ocr_predictor(
        det_arch="db_mobilenet_v3_large",
        reco_arch="crnn_mobilenet_v3_small",
        straighten_pages=True,
    )

    print(f"Reading image: {IMAGE_PATH}")
    doc = DocumentFile.from_images(IMAGE_PATH)

    print("Running OnnxTR inference...")
    t0 = time.time()
    result = predictor(doc)
    elapsed = time.time() - t0
    print(f"OnnxTR inference time: {elapsed:.2f}s")

    # Extract results
    onnxtr_results = []
    for page in result.pages:
        h, w = page.dimensions
        for block in page.blocks:
            for line in block.lines:
                for word in line.words:
                    # Convert relative coords to absolute pixels
                    (x0, y0), (x1, y1) = word.geometry
                    abs_bbox = [
                        [x0 * w, y0 * h],
                        [x1 * w, y0 * h],
                        [x1 * w, y1 * h],
                        [x0 * w, y1 * h],
                    ]
                    onnxtr_results.append({
                        "bbox": abs_bbox,
                        "text": word.value,
                        "confidence": word.confidence,
                    })

    return onnxtr_results, elapsed


def load_cpp_results():
    """Load C++ DocTR results from JSON."""
    with open(CPP_JSON) as f:
        return json.load(f)


def draw_comparison(cpp_results, py_results):
    """Draw side-by-side comparison."""
    img = cv2.imread(IMAGE_PATH)
    if img is None:
        print(f"Error: cannot read {IMAGE_PATH}")
        return

    # C++ results (green)
    cpp_img = img.copy()
    for r in cpp_results:
        if not r["text"].strip():
            continue
        pts = np.array(r["bbox"], dtype=np.int32)
        cv2.polylines(cpp_img, [pts], True, (0, 180, 0), 1)
        label = f"{r['text']} ({r['confidence']:.2f})"
        x, y = int(pts[0][0]), int(pts[0][1]) - 4
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.35, 1)
        cv2.rectangle(cpp_img, (x, y - th - 2), (x + tw, y + 2), (255, 255, 255), -1)
        cv2.putText(cpp_img, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 180, 0), 1, cv2.LINE_AA)

    # Python results (purple)
    py_img = img.copy()
    for r in py_results:
        if not r["text"].strip():
            continue
        pts = np.array(r["bbox"], dtype=np.int32)
        cv2.polylines(py_img, [pts], True, (180, 0, 180), 1)
        label = f"{r['text']} ({r['confidence']:.2f})"
        x, y = int(pts[0][0]), int(pts[0][1]) - 4
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.35, 1)
        cv2.rectangle(py_img, (x, y - th - 2), (x + tw, y + 2), (255, 255, 255), -1)
        cv2.putText(py_img, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (180, 0, 180), 1, cv2.LINE_AA)

    # Save individual images
    cpp_out = os.path.join(OUTPUT_DIR, "lab_results_cpp_doctr.png")
    py_out = os.path.join(OUTPUT_DIR, "lab_results_python_onnxtr.png")
    cv2.imwrite(cpp_out, cpp_img)
    cv2.imwrite(py_out, py_img)
    print(f"Saved: {cpp_out}")
    print(f"Saved: {py_out}")

    # Side-by-side
    h, w = img.shape[:2]
    header_h = 50

    cpp_header = np.ones((header_h, w, 3), dtype=np.uint8) * 255
    py_header = np.ones((header_h, w, 3), dtype=np.uint8) * 255
    cv2.putText(cpp_header, f"C++ DocTR - {len(cpp_results)} words",
                (10, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 140, 0), 2, cv2.LINE_AA)
    cv2.putText(py_header, f"Python OnnxTR - {len(py_results)} words",
                (10, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (140, 0, 140), 2, cv2.LINE_AA)

    left = np.vstack([cpp_header, cpp_img])
    right = np.vstack([py_header, py_img])
    sep = np.ones((left.shape[0], 4, 3), dtype=np.uint8) * 128
    combined = np.hstack([left, sep, right])

    combined_out = os.path.join(OUTPUT_DIR, "lab_results_cpp_vs_python.png")
    cv2.imwrite(combined_out, combined)
    print(f"Saved comparison: {combined_out}")


def compare_texts(cpp_results, py_results):
    """Compare detected texts between C++ and Python implementations."""
    cpp_texts = sorted([r["text"].lower() for r in cpp_results if r["text"].strip()])
    py_texts = sorted([r["text"].lower() for r in py_results if r["text"].strip()])

    cpp_set = set(cpp_texts)
    py_set = set(py_texts)

    common = cpp_set & py_set
    cpp_only = cpp_set - py_set
    py_only = py_set - cpp_set

    print(f"\n{'='*60}")
    print(f"TEXT COMPARISON")
    print(f"{'='*60}")
    print(f"C++ words:    {len(cpp_texts)} ({len(cpp_set)} unique)")
    print(f"Python words: {len(py_texts)} ({len(py_set)} unique)")
    print(f"Common:       {len(common)}")
    print(f"C++ only:     {len(cpp_only)}")
    print(f"Python only:  {len(py_only)}")

    print(f"\n--- Common words ({len(common)}) ---")
    for w in sorted(common):
        # Find confidence in both
        cpp_conf = max(r["confidence"] for r in cpp_results if r["text"].lower() == w)
        py_conf = max(r["confidence"] for r in py_results if r["text"].lower() == w)
        diff = cpp_conf - py_conf
        marker = " " if abs(diff) < 0.1 else ("+" if diff > 0 else "-")
        print(f"  {marker} {w:30s}  C++={cpp_conf:.3f}  Py={py_conf:.3f}  diff={diff:+.3f}")

    if cpp_only:
        print(f"\n--- C++ only ({len(cpp_only)}) ---")
        for w in sorted(cpp_only):
            conf = max(r["confidence"] for r in cpp_results if r["text"].lower() == w)
            print(f"    {w:30s}  conf={conf:.3f}")

    if py_only:
        print(f"\n--- Python only ({len(py_only)}) ---")
        for w in sorted(py_only):
            conf = max(r["confidence"] for r in py_results if r["text"].lower() == w)
            print(f"    {w:30s}  conf={conf:.3f}")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Load C++ results
    print("Loading C++ DocTR results...")
    cpp_results = load_cpp_results()
    print(f"C++ DocTR: {len(cpp_results)} words")

    # Run Python OnnxTR
    py_results, py_time = run_onnxtr()
    print(f"Python OnnxTR: {len(py_results)} words in {py_time:.2f}s")

    # Save Python results JSON
    py_json = os.path.join(OUTPUT_DIR, "lab_results_python_onnxtr.json")
    with open(py_json, "w") as f:
        json.dump(py_results, f, indent=2)
    print(f"Saved: {py_json}")

    # Compare texts
    compare_texts(cpp_results, py_results)

    # Draw comparison images
    print(f"\n{'='*60}")
    print("DRAWING BOUNDING BOXES")
    print(f"{'='*60}")
    draw_comparison(cpp_results, py_results)


if __name__ == "__main__":
    main()
