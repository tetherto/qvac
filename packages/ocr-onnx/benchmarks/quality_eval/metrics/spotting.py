"""Text spotting evaluation metrics.

Evaluates both detection (bounding box IoU) and recognition (text accuracy).

Follows ICDAR standard:
- IoU >= 0.5 for detection match
- Case-insensitive text comparison
- Reports precision, recall, F1 (H-mean)
"""

import re
from typing import List, Tuple, Dict, Any
from PIL import Image


def normalize_text(text: str) -> str:
    """Normalize text for comparison (ICDAR standard).

    - Convert to lowercase
    - Strip whitespace
    """
    return text.lower().strip()


def normalize_text_strict(text: str) -> str:
    """Stricter normalization - also remove punctuation/special chars."""
    text = text.lower().strip()
    # Remove non-alphanumeric characters
    text = re.sub(r'[^a-z0-9]', '', text)
    return text


def compute_ned(pred: str, gt: str) -> float:
    """Compute Normalized Edit Distance between two strings.

    Returns value between 0 (identical) and 1 (completely different).
    """
    if not gt and not pred:
        return 0.0
    if not gt or not pred:
        return 1.0

    # Levenshtein distance
    m, n = len(pred), len(gt)
    dp = [[0] * (n + 1) for _ in range(m + 1)]

    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if pred[i-1] == gt[j-1]:
                dp[i][j] = dp[i-1][j-1]
            else:
                dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])

    edit_distance = dp[m][n]
    return edit_distance / max(m, n)


def compute_anls(pred: str, gt: str, threshold: float = 0.5) -> float:
    """Compute ANLS (Average Normalized Levenshtein Similarity).

    ANLS = 1 - NED if NED < threshold, else 0
    """
    ned = compute_ned(pred, gt)
    if ned < threshold:
        return 1.0 - ned
    return 0.0


def get_image_dimensions(image_path: str) -> Tuple[int, int]:
    """Get image width and height.

    Args:
        image_path: Path to image file

    Returns:
        Tuple of (width, height)
    """
    with Image.open(image_path) as img:
        return img.size  # (width, height)


def normalize_box_to_1000(box_points: List[List[float]],
                          img_width: int, img_height: int) -> Tuple[int, int, int, int]:
    """Convert bounding box to normalized (0-1000) coordinates.

    Args:
        box_points: List of 4 corner points [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
        img_width: Image width in pixels
        img_height: Image height in pixels

    Returns:
        Tuple of (x1, y1, x2, y2) normalized to 0-1000 range
    """
    # Extract all x and y coordinates
    x_coords = [p[0] for p in box_points]
    y_coords = [p[1] for p in box_points]

    # Get bounding rectangle
    x1 = min(x_coords)
    y1 = min(y_coords)
    x2 = max(x_coords)
    y2 = max(y_coords)

    # Normalize to 0-1000
    x1_norm = int(x1 / img_width * 1000)
    y1_norm = int(y1 / img_height * 1000)
    x2_norm = int(x2 / img_width * 1000)
    y2_norm = int(y2 / img_height * 1000)

    # Clamp to valid range
    x1_norm = max(0, min(1000, x1_norm))
    y1_norm = max(0, min(1000, y1_norm))
    x2_norm = max(0, min(1000, x2_norm))
    y2_norm = max(0, min(1000, y2_norm))

    return (x1_norm, y1_norm, x2_norm, y2_norm)


def compute_iou(box1: Tuple[int, int, int, int],
                box2: Tuple[int, int, int, int]) -> float:
    """Compute Intersection over Union between two boxes.

    Args:
        box1: (x1, y1, x2, y2)
        box2: (x1, y1, x2, y2)

    Returns:
        IoU value between 0 and 1
    """
    x1 = max(box1[0], box2[0])
    y1 = max(box1[1], box2[1])
    x2 = min(box1[2], box2[2])
    y2 = min(box1[3], box2[3])

    # Compute intersection
    intersection = max(0, x2 - x1) * max(0, y2 - y1)

    # Compute areas
    area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
    area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])

    # Compute union
    union = area1 + area2 - intersection

    if union <= 0:
        return 0.0

    return intersection / union


def parse_gt_boxes(sample: Dict[str, Any]) -> List[Tuple[Tuple[int, int, int, int], str]]:
    """Parse ground truth bounding boxes and text from sample.

    Args:
        sample: Sample dict with 'bbox' and 'content' fields

    Returns:
        List of ((x1, y1, x2, y2), text) tuples
    """
    bboxes = sample.get("bbox", [])
    contents = sample.get("content", [])

    result = []
    for bbox, text in zip(bboxes, contents):
        # bbox is polygon format: [x1, y1, x2, y2, x3, y3, x4, y4]
        x_coords = bbox[0::2]
        y_coords = bbox[1::2]

        x1 = int(min(x_coords))
        y1 = int(min(y_coords))
        x2 = int(max(x_coords))
        y2 = int(max(y_coords))

        result.append(((x1, y1, x2, y2), str(text)))

    return result


def evaluate_text_spotting(
    pred_boxes: List[Dict[str, Any]],
    gt_boxes: List[Tuple[Tuple[int, int, int, int], str]],
    img_width: int,
    img_height: int,
    iou_threshold: float = 0.5
) -> Dict[str, float]:
    """Evaluate text spotting predictions against ground truth.

    Args:
        pred_boxes: List of predicted boxes with 'points' and 'text'
        gt_boxes: List of (bbox, text) ground truth
        img_width: Image width for normalization
        img_height: Image height for normalization
        iou_threshold: Minimum IoU for a match (default 0.5)

    Returns:
        Dict with precision, recall, f1, and detection/recognition stats
    """
    if not pred_boxes and not gt_boxes:
        return {
            "e2e_precision": 1.0, "e2e_recall": 1.0, "e2e_f1": 1.0, "e2e_hmean": 1.0,
            "det_precision": 1.0, "det_recall": 1.0, "det_f1": 1.0,
            "avg_anls": 1.0, "avg_cer": 0.0,
            "num_pred": 0, "num_gt": 0, "num_matched": 0, "num_correct_text": 0
        }

    if not pred_boxes:
        return {
            "e2e_precision": 0.0, "e2e_recall": 0.0, "e2e_f1": 0.0, "e2e_hmean": 0.0,
            "det_precision": 0.0, "det_recall": 0.0, "det_f1": 0.0,
            "avg_anls": 0.0, "avg_cer": 1.0,
            "num_pred": 0, "num_gt": len(gt_boxes), "num_matched": 0, "num_correct_text": 0
        }

    if not gt_boxes:
        return {
            "e2e_precision": 0.0, "e2e_recall": 0.0, "e2e_f1": 0.0, "e2e_hmean": 0.0,
            "det_precision": 0.0, "det_recall": 0.0, "det_f1": 0.0,
            "avg_anls": 0.0, "avg_cer": 1.0,
            "num_pred": len(pred_boxes), "num_gt": 0, "num_matched": 0, "num_correct_text": 0
        }

    # Normalize predicted boxes
    pred_normalized = []
    for box in pred_boxes:
        norm_box = normalize_box_to_1000(box["points"], img_width, img_height)
        pred_normalized.append((norm_box, normalize_text(box["text"])))

    # Normalize ground truth text for comparison
    gt_normalized = [(b[0], normalize_text(b[1])) for b in gt_boxes]

    # Match predictions to ground truth
    matched_gt = set()
    matched_pred = set()
    correct_text_exact = 0
    total_anls = 0.0
    total_ned = 0.0

    for i, (pred_box, pred_text) in enumerate(pred_normalized):
        best_iou = 0
        best_gt_idx = -1

        for j, (gt_box, gt_text) in enumerate(gt_normalized):
            if j in matched_gt:
                continue

            iou = compute_iou(pred_box, gt_box)
            if iou > best_iou:
                best_iou = iou
                best_gt_idx = j

        if best_iou >= iou_threshold and best_gt_idx >= 0:
            matched_gt.add(best_gt_idx)
            matched_pred.add(i)

            # Check text match quality
            gt_text = gt_normalized[best_gt_idx][1]

            # Exact match (case-insensitive, already normalized)
            if pred_text == gt_text:
                correct_text_exact += 1

            # ANLS for matched boxes
            anls = compute_anls(pred_text, gt_text)
            total_anls += anls

            # NED for matched boxes
            ned = compute_ned(pred_text, gt_text)
            total_ned += ned

    num_matched = len(matched_pred)
    num_pred = len(pred_normalized)
    num_gt = len(gt_normalized)

    # End-to-end metrics with exact match (ICDAR standard)
    precision_exact = correct_text_exact / num_pred if num_pred > 0 else 0.0
    recall_exact = correct_text_exact / num_gt if num_gt > 0 else 0.0
    f1_exact = 2 * precision_exact * recall_exact / (precision_exact + recall_exact) if (precision_exact + recall_exact) > 0 else 0.0

    # Detection-only metrics (just box matching)
    det_precision = num_matched / num_pred if num_pred > 0 else 0.0
    det_recall = num_matched / num_gt if num_gt > 0 else 0.0
    det_f1 = 2 * det_precision * det_recall / (det_precision + det_recall) if (det_precision + det_recall) > 0 else 0.0

    # Average ANLS and NED for matched boxes
    avg_anls = total_anls / num_matched if num_matched > 0 else 0.0
    avg_ned = total_ned / num_matched if num_matched > 0 else 1.0
    avg_cer = avg_ned  # NED is equivalent to CER for single strings

    return {
        # End-to-end (exact match) - ICDAR standard
        "e2e_precision": precision_exact,
        "e2e_recall": recall_exact,
        "e2e_f1": f1_exact,
        "e2e_hmean": f1_exact,
        # Detection only
        "det_precision": det_precision,
        "det_recall": det_recall,
        "det_f1": det_f1,
        # Text quality metrics (for matched boxes)
        "avg_anls": avg_anls,
        "avg_cer": avg_cer,  # CER = NED for matched text
        # Counts
        "num_pred": num_pred,
        "num_gt": num_gt,
        "num_matched": num_matched,
        "num_correct_text": correct_text_exact
    }
