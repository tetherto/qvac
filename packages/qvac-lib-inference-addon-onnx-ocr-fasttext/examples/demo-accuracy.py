#!/usr/bin/env python3
"""
OCR Accuracy Comparison: DocTR vs EasyOCR against Ground Truth

Loads word-level ground truth and model outputs, then computes bounding box
accuracy, text accuracy (CER + exact match), and speed metrics. Generates
visual comparison images with color-coded error highlighting.

Usage:
    python examples/demo-accuracy.py

Prerequisites:
    1. bare examples/demo-compare.js   (generates model outputs)
    2. python examples/gt-annotate.py   (create/review ground truth)

Output:
    test/output/accuracy_doctr.png       - DocTR errors highlighted
    test/output/accuracy_easyocr.png     - EasyOCR errors highlighted
    test/output/accuracy_comparison.png  - Side-by-side with metrics
    test/output/accuracy_report.json     - Full metrics report
"""

import json
import os
import sys

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(SCRIPT_DIR)

IMAGE_PATH = os.path.join(PKG_DIR, "test", "images", "lab_results.png")
GT_PATH = os.path.join(PKG_DIR, "test", "images", "ground_truth.json")
DOCTR_PATH = os.path.join(PKG_DIR, "test", "output", "demo_doctr.json")
EASYOCR_PATH = os.path.join(PKG_DIR, "test", "output", "demo_easyocr.json")
OUTPUT_DIR = os.path.join(PKG_DIR, "test", "output")

# ---------------------------------------------------------------------------
# Configurable thresholds — tune these to adjust sensitivity
# ---------------------------------------------------------------------------
THRESHOLDS = {
    # A GT word is "claimed" by a prediction if this fraction of the GT word's
    # area overlaps with the prediction bbox
    "overlap_ratio": 0.5,
    # Minimum IoU between a prediction and its matched GT group to count as
    # a bbox match (for precision/recall)
    "iou_match": 0.3,
    # IoU above this is considered a "good" bbox match (green on visualization)
    "iou_good": 0.6,
    # IoU below this shown as a significant bbox error (orange on visualization)
    "iou_significant_error": 0.3,
    # CER above this is a significant text error (shown on visualization)
    "cer_significant": 0.3,
}

# Colors (BGR for OpenCV)
COLOR_CORRECT = (0, 180, 0)       # green: bbox+text correct
COLOR_TEXT_ERR = (0, 180, 255)     # yellow/orange: text error, bbox ok
COLOR_MISSED = (0, 0, 220)        # red: GT region missed entirely
COLOR_FALSE_POS = (220, 120, 0)   # blue: extra prediction, no GT match
COLOR_BBOX_ERR = (0, 100, 255)    # orange: significant bbox mismatch
COLOR_GT_OUTLINE = (180, 180, 180) # gray: GT outline for reference


# ---------------------------------------------------------------------------
# Edit distance (Levenshtein) for CER computation
# ---------------------------------------------------------------------------
def edit_distance(s1, s2):
    m, n = len(s1), len(s2)
    dp = list(range(n + 1))
    for i in range(1, m + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, n + 1):
            temp = dp[j]
            if s1[i - 1] == s2[j - 1]:
                dp[j] = prev
            else:
                dp[j] = 1 + min(prev, dp[j], dp[j - 1])
            prev = temp
    return dp[n]


def compute_cer(predicted, ground_truth):
    pred = predicted.lower().strip()
    gt = ground_truth.lower().strip()
    if not gt:
        return 0.0 if not pred else 1.0
    return edit_distance(pred, gt) / len(gt)


def exact_match(predicted, ground_truth):
    return predicted.lower().strip() == ground_truth.lower().strip()


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
def bbox_bounds(bbox):
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_center(bbox):
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def bbox_area(bbox):
    x1, y1, x2, y2 = bbox_bounds(bbox)
    return max(0, x2 - x1) * max(0, y2 - y1)


def bbox_intersection_area(bbox_a, bbox_b):
    ax1, ay1, ax2, ay2 = bbox_bounds(bbox_a)
    bx1, by1, bx2, by2 = bbox_bounds(bbox_b)
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    return max(0, ix2 - ix1) * max(0, iy2 - iy1)


def bbox_iou(bbox_a, bbox_b):
    inter = bbox_intersection_area(bbox_a, bbox_b)
    area_a = bbox_area(bbox_a)
    area_b = bbox_area(bbox_b)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def union_bbox(bboxes):
    all_x1 = min(bbox_bounds(b)[0] for b in bboxes)
    all_y1 = min(bbox_bounds(b)[1] for b in bboxes)
    all_x2 = max(bbox_bounds(b)[2] for b in bboxes)
    all_y2 = max(bbox_bounds(b)[3] for b in bboxes)
    return [[all_x1, all_y1], [all_x2, all_y1], [all_x2, all_y2], [all_x1, all_y2]]


def reading_order_key(bbox):
    cx, cy = bbox_center(bbox)
    return (int(cy / 30), cx)


# ---------------------------------------------------------------------------
# Merge-aware matching algorithm
# ---------------------------------------------------------------------------
def match_predictions_to_gt(gt_anns, predictions, thresholds):
    """
    Match predictions to ground truth with merge-aware algorithm.

    A prediction can match multiple GT words (phrase-level detection),
    and each GT word can only be matched to one prediction.

    Returns:
        matches: list of dicts with keys:
            pred_idx, gt_indices, iou, pred_text, gt_text, cer, is_exact
        missed_gt: list of GT indices not matched by any prediction
        false_positives: list of prediction indices with no GT match
    """
    overlap_thresh = thresholds["overlap_ratio"]

    # For each prediction, find GT words it covers
    pred_to_gt = {}
    for pi, pred in enumerate(predictions):
        pred_to_gt[pi] = []
        for gi, gt in enumerate(gt_anns):
            gt_area = bbox_area(gt["bbox"])
            if gt_area <= 0:
                continue
            inter = bbox_intersection_area(pred["bbox"], gt["bbox"])
            if inter / gt_area >= overlap_thresh:
                pred_to_gt[pi].append(gi)

    # Resolve conflicts: if a GT word is claimed by multiple predictions,
    # assign it to the prediction with highest IoU
    gt_to_pred = {}
    for pi, gt_indices in pred_to_gt.items():
        for gi in gt_indices:
            iou = bbox_iou(predictions[pi]["bbox"], gt_anns[gi]["bbox"])
            if gi not in gt_to_pred or iou > gt_to_pred[gi][1]:
                gt_to_pred[gi] = (pi, iou)

    # Rebuild pred_to_gt after conflict resolution
    resolved = {}
    for gi, (pi, _iou) in gt_to_pred.items():
        resolved.setdefault(pi, []).append(gi)

    # Build matches
    matches = []
    matched_pred = set()
    matched_gt = set()

    for pi, gt_indices in resolved.items():
        gt_indices_sorted = sorted(gt_indices, key=lambda gi: reading_order_key(gt_anns[gi]["bbox"]))
        gt_texts = [gt_anns[gi]["text"] for gi in gt_indices_sorted]
        gt_text_combined = " ".join(gt_texts)

        pred_text = predictions[pi].get("text", "")

        gt_bboxes = [gt_anns[gi]["bbox"] for gi in gt_indices_sorted]
        gt_union = union_bbox(gt_bboxes)
        iou = bbox_iou(predictions[pi]["bbox"], gt_union)

        cer = compute_cer(pred_text, gt_text_combined)
        is_exact = exact_match(pred_text, gt_text_combined)

        matches.append({
            "pred_idx": pi,
            "gt_indices": gt_indices_sorted,
            "iou": iou,
            "pred_text": pred_text,
            "gt_text": gt_text_combined,
            "cer": cer,
            "is_exact": is_exact,
            "pred_bbox": predictions[pi]["bbox"],
            "gt_union_bbox": gt_union,
        })
        matched_pred.add(pi)
        matched_gt.update(gt_indices_sorted)

    missed_gt = [gi for gi in range(len(gt_anns)) if gi not in matched_gt]
    false_positives = [pi for pi in range(len(predictions)) if pi not in matched_pred]

    return matches, missed_gt, false_positives


# ---------------------------------------------------------------------------
# Metrics computation
# ---------------------------------------------------------------------------
def compute_metrics(matches, missed_gt, false_positives, gt_anns, predictions, stats):
    total_gt = len(gt_anns)
    total_pred = len(predictions)

    matched_count = len(matches)
    bbox_matched = sum(1 for m in matches if m["iou"] >= THRESHOLDS["iou_match"])

    precision = bbox_matched / total_pred if total_pred > 0 else 0
    recall = bbox_matched / total_gt if total_gt > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    ious = [m["iou"] for m in matches]
    mean_iou = sum(ious) / len(ious) if ious else 0

    cers = [m["cer"] for m in matches]
    mean_cer = sum(cers) / len(cers) if cers else 0

    exact_matches = sum(1 for m in matches if m["is_exact"])
    exact_rate = exact_matches / len(matches) if matches else 0

    return {
        "total_gt_words": total_gt,
        "total_predictions": total_pred,
        "matched": matched_count,
        "missed_gt": len(missed_gt),
        "false_positives": len(false_positives),
        "bbox_precision": round(precision, 4),
        "bbox_recall": round(recall, 4),
        "bbox_f1": round(f1, 4),
        "mean_iou": round(mean_iou, 4),
        "mean_cer": round(mean_cer, 4),
        "exact_match_rate": round(exact_rate, 4),
        "total_time": stats.get("totalTime"),
        "detection_time": stats.get("detectionTime"),
        "recognition_time": stats.get("recognitionTime"),
    }


# ---------------------------------------------------------------------------
# Visualization
# ---------------------------------------------------------------------------
def draw_accuracy_image(img, gt_anns, matches, missed_gt, false_positives, predictions, model_name, thresholds):
    out = img.copy()

    # 1. Draw all GT boxes as faint gray reference
    for ann in gt_anns:
        x1, y1, x2, y2 = [int(v) for v in bbox_bounds(ann["bbox"])]
        cv2.rectangle(out, (x1, y1), (x2, y2), COLOR_GT_OUTLINE, 1)

    # 2. Draw correct matches (green) — only if no significant errors
    for m in matches:
        iou = m["iou"]
        cer = m["cer"]
        x1, y1, x2, y2 = [int(v) for v in bbox_bounds(m["pred_bbox"])]

        if iou >= thresholds["iou_good"] and cer < thresholds["cer_significant"]:
            cv2.rectangle(out, (x1, y1), (x2, y2), COLOR_CORRECT, 1)
            if not m["is_exact"]:
                _draw_text_diff(out, x1, y1, m["gt_text"], m["pred_text"], COLOR_TEXT_ERR, small=True)
        elif iou < thresholds["iou_significant_error"]:
            gx1, gy1, gx2, gy2 = [int(v) for v in bbox_bounds(m["gt_union_bbox"])]
            cv2.rectangle(out, (gx1, gy1), (gx2, gy2), COLOR_CORRECT, 1)
            cv2.rectangle(out, (x1, y1), (x2, y2), COLOR_BBOX_ERR, 4)
            _draw_label(out, x1, y1 - 18, f"IoU:{iou:.2f}", COLOR_BBOX_ERR)
        elif cer >= thresholds["cer_significant"]:
            cv2.rectangle(out, (x1, y1), (x2, y2), COLOR_TEXT_ERR, 4)
            _draw_text_diff(out, x1, y1, m["gt_text"], m["pred_text"], COLOR_TEXT_ERR)
        else:
            cv2.rectangle(out, (x1, y1), (x2, y2), COLOR_CORRECT, 1)
            if not m["is_exact"]:
                _draw_text_diff(out, x1, y1, m["gt_text"], m["pred_text"], COLOR_TEXT_ERR, small=True)

    # 3. Draw missed GT (red)
    for gi in missed_gt:
        x1, y1, x2, y2 = [int(v) for v in bbox_bounds(gt_anns[gi]["bbox"])]
        cv2.rectangle(out, (x1, y1), (x2, y2), COLOR_MISSED, 4)
        _draw_label(out, x1, y2 + 2, f"MISS: {gt_anns[gi]['text']}", COLOR_MISSED)

    # 4. Draw false positives (blue) — only for non-empty predictions
    for pi in false_positives:
        text = predictions[pi].get("text", "").strip()
        if not text:
            continue
        x1, y1, x2, y2 = [int(v) for v in bbox_bounds(predictions[pi]["bbox"])]
        cv2.rectangle(out, (x1, y1), (x2, y2), COLOR_FALSE_POS, 4)
        _draw_label(out, x1, y2 + 2, f"FP: {text}", COLOR_FALSE_POS)

    return out


def _draw_label(img, x, y, text, color, scale=0.35):
    (tw, th), _ = cv2.getTextSize(text[:60], cv2.FONT_HERSHEY_SIMPLEX, scale, 1)
    y = max(th + 4, y)
    cv2.rectangle(img, (x, y - th - 4), (x + tw + 4, y + 2), (255, 255, 255), -1)
    cv2.putText(img, text[:60], (x + 2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def _draw_text_diff(img, x, y, gt_text, pred_text, color, small=False):
    scale = 0.3 if small else 0.35
    gt_show = gt_text[:40]
    pred_show = pred_text[:40]
    label = f"'{pred_show}' != '{gt_show}'"
    _draw_label(img, x, y - 2, label, color, scale)


def format_time(seconds):
    if not seconds:
        return "?"
    if seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    return f"{seconds:.2f}s"


def draw_combined_comparison(img, doctr_img, easyocr_img, doctr_metrics, easyocr_metrics):
    h, w = img.shape[:2]
    header_h = 60
    footer_h = 260

    def make_header(text, color):
        hdr = np.ones((header_h, w, 3), dtype=np.uint8) * 255
        cv2.putText(hdr, text, (10, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2, cv2.LINE_AA)
        return hdr

    dm = doctr_metrics
    em = easyocr_metrics

    doctr_hdr = make_header(
        f"DocTR - P:{dm['bbox_precision']:.0%} R:{dm['bbox_recall']:.0%} "
        f"CER:{dm['mean_cer']:.1%} ExactMatch:{dm['exact_match_rate']:.0%} "
        f"Time:{format_time(dm['total_time'])}",
        (0, 140, 0),
    )
    easyocr_hdr = make_header(
        f"EasyOCR - P:{em['bbox_precision']:.0%} R:{em['bbox_recall']:.0%} "
        f"CER:{em['mean_cer']:.1%} ExactMatch:{em['exact_match_rate']:.0%} "
        f"Time:{format_time(em['total_time'])}",
        (160, 80, 0),
    )

    left = np.vstack([doctr_hdr, doctr_img])
    right = np.vstack([easyocr_hdr, easyocr_img])
    sep = np.ones((left.shape[0], 4, 3), dtype=np.uint8) * 128
    combined = np.hstack([left, sep, right])

    # Footer with detailed metrics table
    footer = np.ones((footer_h, combined.shape[1], 3), dtype=np.uint8) * 250
    y0 = 25
    line_h = 22
    font = cv2.FONT_HERSHEY_SIMPLEX
    fs = 0.5
    black = (0, 0, 0)
    col1 = 20
    col2 = 320
    col3 = 560

    cv2.putText(footer, "Metric", (col1, y0), font, fs, black, 2, cv2.LINE_AA)
    cv2.putText(footer, "DocTR", (col2, y0), font, fs, (0, 140, 0), 2, cv2.LINE_AA)
    cv2.putText(footer, "EasyOCR", (col3, y0), font, fs, (160, 80, 0), 2, cv2.LINE_AA)
    cv2.line(footer, (col1, y0 + 5), (col3 + 150, y0 + 5), (180, 180, 180), 1)

    rows = [
        ("GT Words", str(dm["total_gt_words"]), str(em["total_gt_words"])),
        ("Predictions", str(dm["total_predictions"]), str(em["total_predictions"])),
        ("Matched", str(dm["matched"]), str(em["matched"])),
        ("Missed GT", str(dm["missed_gt"]), str(em["missed_gt"])),
        ("False Positives", str(dm["false_positives"]), str(em["false_positives"])),
        ("Bbox Precision", f"{dm['bbox_precision']:.1%}", f"{em['bbox_precision']:.1%}"),
        ("Bbox Recall", f"{dm['bbox_recall']:.1%}", f"{em['bbox_recall']:.1%}"),
        ("Bbox F1", f"{dm['bbox_f1']:.1%}", f"{em['bbox_f1']:.1%}"),
        ("Mean IoU", f"{dm['mean_iou']:.3f}", f"{em['mean_iou']:.3f}"),
        ("Mean CER", f"{dm['mean_cer']:.1%}", f"{em['mean_cer']:.1%}"),
        ("Exact Match Rate", f"{dm['exact_match_rate']:.1%}", f"{em['exact_match_rate']:.1%}"),
    ]

    for i, (label, dv, ev) in enumerate(rows):
        y = y0 + (i + 1) * line_h
        cv2.putText(footer, label, (col1, y), font, 0.45, black, 1, cv2.LINE_AA)
        cv2.putText(footer, dv, (col2, y), font, 0.45, (0, 140, 0), 1, cv2.LINE_AA)
        cv2.putText(footer, ev, (col3, y), font, 0.45, (160, 80, 0), 1, cv2.LINE_AA)

    combined = np.vstack([combined, footer])
    return combined


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    for path, label in [(IMAGE_PATH, "Image"), (GT_PATH, "Ground truth"), (DOCTR_PATH, "DocTR output"), (EASYOCR_PATH, "EasyOCR output")]:
        if not os.path.exists(path):
            print(f"Missing {label}: {path}")
            if label == "Ground truth":
                print("Run first: python examples/gt-annotate.py")
            elif label in ("DocTR output", "EasyOCR output"):
                print("Run first: bare examples/demo-compare.js")
            sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    img = cv2.imread(IMAGE_PATH)
    if img is None:
        print(f"Cannot read image: {IMAGE_PATH}")
        sys.exit(1)

    # Load data
    with open(GT_PATH) as f:
        gt_data = json.load(f)
    gt_anns = gt_data["annotations"]

    with open(DOCTR_PATH) as f:
        doctr_data = json.load(f)
    doctr_preds = doctr_data["results"]
    doctr_stats = doctr_data["stats"]

    with open(EASYOCR_PATH) as f:
        easyocr_data = json.load(f)
    easyocr_preds = easyocr_data["results"]
    easyocr_stats = easyocr_data["stats"]

    print(f"Ground truth: {len(gt_anns)} word annotations")
    print(f"DocTR:        {len(doctr_preds)} predictions")
    print(f"EasyOCR:      {len(easyocr_preds)} predictions")
    print()

    # Match and compute metrics
    print("Matching DocTR predictions to ground truth...")
    d_matches, d_missed, d_fp = match_predictions_to_gt(gt_anns, doctr_preds, THRESHOLDS)
    d_metrics = compute_metrics(d_matches, d_missed, d_fp, gt_anns, doctr_preds, doctr_stats)

    print("Matching EasyOCR predictions to ground truth...")
    e_matches, e_missed, e_fp = match_predictions_to_gt(gt_anns, easyocr_preds, THRESHOLDS)
    e_metrics = compute_metrics(e_matches, e_missed, e_fp, gt_anns, easyocr_preds, easyocr_stats)

    # Print summary
    sep = "=" * 60
    print(f"\n{sep}")
    print("  OCR Accuracy Comparison: DocTR vs EasyOCR")
    print(sep)
    print(f"  {'Metric':<24} {'DocTR':>10} {'EasyOCR':>10}")
    print(f"  {'-'*24} {'-'*10} {'-'*10}")

    rows = [
        ("GT Words", d_metrics["total_gt_words"], e_metrics["total_gt_words"]),
        ("Predictions", d_metrics["total_predictions"], e_metrics["total_predictions"]),
        ("Matched", d_metrics["matched"], e_metrics["matched"]),
        ("Missed", d_metrics["missed_gt"], e_metrics["missed_gt"]),
        ("False Positives", d_metrics["false_positives"], e_metrics["false_positives"]),
        ("Bbox Precision", f"{d_metrics['bbox_precision']:.1%}", f"{e_metrics['bbox_precision']:.1%}"),
        ("Bbox Recall", f"{d_metrics['bbox_recall']:.1%}", f"{e_metrics['bbox_recall']:.1%}"),
        ("Bbox F1", f"{d_metrics['bbox_f1']:.1%}", f"{e_metrics['bbox_f1']:.1%}"),
        ("Mean IoU", f"{d_metrics['mean_iou']:.3f}", f"{e_metrics['mean_iou']:.3f}"),
        ("Mean CER", f"{d_metrics['mean_cer']:.1%}", f"{e_metrics['mean_cer']:.1%}"),
        ("Exact Match", f"{d_metrics['exact_match_rate']:.1%}", f"{e_metrics['exact_match_rate']:.1%}"),
        ("Total Time", format_time(d_metrics["total_time"]), format_time(e_metrics["total_time"])),
    ]
    for label, dv, ev in rows:
        print(f"  {label:<24} {str(dv):>10} {str(ev):>10}")

    if d_metrics["total_time"] and e_metrics["total_time"]:
        speedup = e_metrics["total_time"] / d_metrics["total_time"]
        print(f"  {'-'*24} {'-'*10} {'-'*10}")
        print(f"  {'Speedup':<24} {f'{speedup:.1f}x':>10}")
    print(sep)

    # Generate per-model accuracy images
    print("\nGenerating visualizations...")
    doctr_img = draw_accuracy_image(img, gt_anns, d_matches, d_missed, d_fp, doctr_preds, "DocTR", THRESHOLDS)
    easyocr_img = draw_accuracy_image(img, gt_anns, e_matches, e_missed, e_fp, easyocr_preds, "EasyOCR", THRESHOLDS)

    doctr_out = os.path.join(OUTPUT_DIR, "accuracy_doctr.png")
    easyocr_out = os.path.join(OUTPUT_DIR, "accuracy_easyocr.png")
    cv2.imwrite(doctr_out, doctr_img)
    cv2.imwrite(easyocr_out, easyocr_img)
    print(f"Saved: {doctr_out}")
    print(f"Saved: {easyocr_out}")

    # Combined comparison
    combined = draw_combined_comparison(img, doctr_img, easyocr_img, d_metrics, e_metrics)
    combined_out = os.path.join(OUTPUT_DIR, "accuracy_comparison.png")
    cv2.imwrite(combined_out, combined)
    print(f"Saved: {combined_out}")

    # Save report JSON
    report = {
        "thresholds": THRESHOLDS,
        "ground_truth_count": len(gt_anns),
        "doctr": d_metrics,
        "easyocr": e_metrics,
    }
    report_out = os.path.join(OUTPUT_DIR, "accuracy_report.json")
    with open(report_out, "w") as f:
        json.dump(report, f, indent=2)
    print(f"Saved: {report_out}")

    # Print notable errors for debugging
    print("\n--- DocTR notable text errors (CER > 30%) ---")
    for m in sorted(d_matches, key=lambda x: -x["cer"])[:10]:
        if m["cer"] > THRESHOLDS["cer_significant"]:
            print(f"  CER {m['cer']:.0%}: predicted '{m['pred_text']}' vs GT '{m['gt_text']}'")

    print("\n--- EasyOCR notable text errors (CER > 30%) ---")
    for m in sorted(e_matches, key=lambda x: -x["cer"])[:10]:
        if m["cer"] > THRESHOLDS["cer_significant"]:
            print(f"  CER {m['cer']:.0%}: predicted '{m['pred_text']}' vs GT '{m['gt_text']}'")


if __name__ == "__main__":
    main()
