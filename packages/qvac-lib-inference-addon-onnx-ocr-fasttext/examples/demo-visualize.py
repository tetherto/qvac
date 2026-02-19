#!/usr/bin/env python3
"""
DocTR vs EasyOCR Visual Comparison

Loads JSON results from demo-compare.js and creates a side-by-side
bounding box comparison image.

Usage: python3 examples/demo-visualize.py

Prerequisites:
    bare examples/demo-compare.js  (generates the JSON files first)

Output:
    test/output/demo_doctr_bboxes.png
    test/output/demo_easyocr_bboxes.png
    test/output/demo_doctr_vs_easyocr.png  (side-by-side)
"""

import json
import os
import sys

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(SCRIPT_DIR)

IMAGE_PATH = os.path.join(PKG_DIR, "test/images/lab_results.png")
OUTPUT_DIR = os.path.join(PKG_DIR, "test/output")
DOCTR_JSON = os.path.join(OUTPUT_DIR, "demo_doctr.json")
EASYOCR_JSON = os.path.join(OUTPUT_DIR, "demo_easyocr.json")

# Colors (BGR)
GREEN = (0, 180, 0)
BLUE = (180, 80, 0)
WHITE = (255, 255, 255)


def load_results(json_path):
    """Load results JSON from demo-compare.js."""
    with open(json_path) as f:
        data = json.load(f)
    return data.get("results", []), data.get("stats", {})


def draw_bboxes(img, results, color):
    """Draw bounding boxes and text labels on an image copy."""
    out = img.copy()
    for r in results:
        text = r.get("text", "").strip()
        if not text:
            continue
        pts = np.array(r["bbox"], dtype=np.int32)
        cv2.polylines(out, [pts], True, color, 1)

        label = f"{text} ({r['confidence']:.2f})"
        x, y = int(pts[0][0]), int(pts[0][1]) - 4
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.35, 1)
        cv2.rectangle(out, (x, y - th - 2), (x + tw, y + 2), WHITE, -1)
        cv2.putText(out, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA)

    return out


def format_time(seconds):
    """Format time value from stats."""
    if not seconds:
        return "?"
    if seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    return f"{seconds:.2f}s"


def main():
    # Check prerequisites
    for fpath in [IMAGE_PATH, DOCTR_JSON, EASYOCR_JSON]:
        if not os.path.exists(fpath):
            print(f"Missing: {fpath}")
            print("Run first: bare examples/demo-compare.js")
            sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    img = cv2.imread(IMAGE_PATH)
    if img is None:
        print(f"Error: cannot read {IMAGE_PATH}")
        sys.exit(1)

    doctr_results, doctr_stats = load_results(DOCTR_JSON)
    easyocr_results, easyocr_stats = load_results(EASYOCR_JSON)

    print(f"DocTR:   {len(doctr_results)} words, {format_time(doctr_stats.get('totalTime'))}")
    print(f"EasyOCR: {len(easyocr_results)} words, {format_time(easyocr_stats.get('totalTime'))}")

    # Draw individual images
    doctr_img = draw_bboxes(img, doctr_results, GREEN)
    easyocr_img = draw_bboxes(img, easyocr_results, BLUE)

    doctr_out = os.path.join(OUTPUT_DIR, "demo_doctr_bboxes.png")
    easyocr_out = os.path.join(OUTPUT_DIR, "demo_easyocr_bboxes.png")
    cv2.imwrite(doctr_out, doctr_img)
    cv2.imwrite(easyocr_out, easyocr_img)
    print(f"Saved: {doctr_out}")
    print(f"Saved: {easyocr_out}")

    # Side-by-side comparison
    h, w = img.shape[:2]
    header_h = 50

    # DocTR header (green)
    doctr_time = format_time(doctr_stats.get("totalTime"))
    doctr_header = np.ones((header_h, w, 3), dtype=np.uint8) * 255
    cv2.putText(
        doctr_header,
        f"DocTR - {len(doctr_results)} words - {doctr_time}",
        (10, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.7, GREEN, 2, cv2.LINE_AA,
    )

    # EasyOCR header (blue)
    easyocr_time = format_time(easyocr_stats.get("totalTime"))
    easyocr_header = np.ones((header_h, w, 3), dtype=np.uint8) * 255
    cv2.putText(
        easyocr_header,
        f"EasyOCR - {len(easyocr_results)} words - {easyocr_time}",
        (10, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.7, BLUE, 2, cv2.LINE_AA,
    )

    left = np.vstack([doctr_header, doctr_img])
    right = np.vstack([easyocr_header, easyocr_img])
    sep = np.ones((left.shape[0], 4, 3), dtype=np.uint8) * 128
    combined = np.hstack([left, sep, right])

    # Add speedup footer if both times available
    doctr_t = doctr_stats.get("totalTime")
    easyocr_t = easyocr_stats.get("totalTime")
    if doctr_t and easyocr_t:
        speedup = easyocr_t / doctr_t
        footer_h = 40
        footer = np.ones((footer_h, combined.shape[1], 3), dtype=np.uint8) * 245
        cv2.putText(
            footer,
            f"DocTR is {speedup:.1f}x faster than EasyOCR",
            (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2, cv2.LINE_AA,
        )
        combined = np.vstack([combined, footer])

    combined_out = os.path.join(OUTPUT_DIR, "demo_doctr_vs_easyocr.png")
    cv2.imwrite(combined_out, combined)
    print(f"Saved comparison: {combined_out}")


if __name__ == "__main__":
    main()
