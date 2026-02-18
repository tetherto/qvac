"""
Compare Python OnnxTR output with C++ implementation output.
Uses both the OnnxTR library and a manual pipeline (matching C++ logic)
to validate results.
"""

import time
import json
import sys
import os
import numpy as np
import cv2
from pathlib import Path

import onnxruntime as ort

SCRIPT_DIR = Path(__file__).parent
ADDON_DIR = SCRIPT_DIR.parent
DETECTOR_PATH = str(ADDON_DIR / "test" / "models" / "doctr" / "db_resnet50.onnx")
RECOGNIZER_PATH = str(ADDON_DIR / "test" / "models" / "doctr" / "parseq.onnx")

# DocTR constants matching our C++ implementation
DBNET_INPUT_SIZE = 1024
DET_MEAN = np.array([0.798, 0.785, 0.772], dtype=np.float32)
DET_STD = np.array([0.264, 0.2749, 0.287], dtype=np.float32)

RECOG_HEIGHT = 32
RECOG_WIDTH = 128
REC_MEAN = np.array([0.694, 0.695, 0.693], dtype=np.float32)
REC_STD = np.array([0.299, 0.296, 0.301], dtype=np.float32)

BINARIZE_THRESHOLD = 0.3
BOX_THRESHOLD = 0.1
UNCLIP_RATIO = 1.5
MIN_SIZE_BOX = 2

# French vocab (126 chars) matching the HuggingFace parseq model
VOCAB = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~°£€¥¢฿àâéèêëîïôùûüçÀÂÉÈÊËÎÏÔÙÛÜÇ'
EOS_IDX = 126  # <eos> at index 126 (= len(vocab))


def preprocess_detection(image):
    """Preprocess image for DBNet detection - matching C++ implementation."""
    h, w = image.shape[:2]
    scale = min(DBNET_INPUT_SIZE / h, DBNET_INPUT_SIZE / w)
    new_h = int(h * scale)
    new_w = int(w * scale)

    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    resized_rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)

    padded = np.zeros((DBNET_INPUT_SIZE, DBNET_INPUT_SIZE, 3), dtype=np.float32)
    padded[:new_h, :new_w, :] = resized_rgb.astype(np.float32) / 255.0
    padded = (padded - DET_MEAN) / DET_STD

    tensor = np.transpose(padded, (2, 0, 1))
    tensor = np.expand_dims(tensor, axis=0).astype(np.float32)
    return tensor, scale, new_h, new_w


def box_score(prob_map, contour):
    h, w = prob_map.shape
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [contour], 1)
    return cv2.mean(prob_map, mask)[0]


def unclip_polygon(box, ratio):
    import pyclipper
    poly = pyclipper.PyclipperOffset()
    points = box.tolist()
    area = cv2.contourArea(box)
    perimeter = cv2.arcLength(box, True)
    if perimeter == 0:
        return box
    distance = area * ratio / perimeter
    poly.AddPath(points, pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    expanded = poly.Execute(distance)
    if not expanded:
        return box
    return np.array(expanded[0], dtype=np.int32)


def extract_polygons(prob_map, scale, orig_h, orig_w, new_h, new_w):
    binary = (prob_map > BINARIZE_THRESHOLD).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    polygons = []
    confidences = []
    for contour in contours:
        rect = cv2.minAreaRect(contour)
        w_r, h_r = rect[1]
        if min(w_r, h_r) < MIN_SIZE_BOX:
            continue
        score = box_score(prob_map[:new_h, :new_w], contour)
        if score < BOX_THRESHOLD:
            continue
        expanded = unclip_polygon(contour.reshape(-1, 2), UNCLIP_RATIO)
        expanded_rect = cv2.minAreaRect(expanded.reshape(-1, 1, 2))
        box_points = cv2.boxPoints(expanded_rect)
        box_points = box_points / scale
        polygons.append(box_points)
        confidences.append(score)
    return polygons, confidences


def four_point_transform(image, pts):
    rect = np.array(pts, dtype=np.float32)
    w1 = np.linalg.norm(rect[1] - rect[0])
    w2 = np.linalg.norm(rect[2] - rect[3])
    max_w = int(max(w1, w2))
    h1 = np.linalg.norm(rect[3] - rect[0])
    h2 = np.linalg.norm(rect[2] - rect[1])
    max_h = int(max(h1, h2))
    if max_w <= 0 or max_h <= 0:
        return None
    dst = np.array([[0, 0], [max_w - 1, 0], [max_w - 1, max_h - 1], [0, max_h - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, M, (max_w, max_h))


def preprocess_recognition(crop):
    """Preprocess crop for PARSeq - matching C++ implementation."""
    resized = cv2.resize(crop, (RECOG_WIDTH, RECOG_HEIGHT), interpolation=cv2.INTER_LINEAR)
    # Convert BGR to RGB (matching C++ fix)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    normalized = rgb.astype(np.float32) / 255.0
    normalized = (normalized - REC_MEAN) / REC_STD
    return np.transpose(normalized, (2, 0, 1))


def decode_parseq(logits):
    vocab_chars = list(VOCAB)
    results = []
    for batch_idx in range(logits.shape[0]):
        text = ""
        confidence = 1.0
        num_chars = 0
        for pos in range(logits.shape[1]):
            row = logits[batch_idx, pos, :]
            exp_vals = np.exp(row - np.max(row))
            probs = exp_vals / np.sum(exp_vals)
            max_idx = np.argmax(probs)
            max_prob = probs[max_idx]
            if max_idx >= EOS_IDX:
                break
            if max_idx < len(vocab_chars):
                text += vocab_chars[max_idx]
                confidence *= max_prob
                num_chars += 1
        if num_chars > 0:
            confidence = confidence ** (1.0 / num_chars)
        results.append((text, float(confidence)))
    return results


def run_manual_pipeline(image_path):
    """Run the full DocTR pipeline matching C++ implementation."""
    print(f"\n{'='*60}")
    print(f"Manual Pipeline: {os.path.basename(image_path)}")
    print(f"{'='*60}")

    image = cv2.imread(image_path)
    if image is None:
        print(f"ERROR: Could not load image: {image_path}")
        return []

    orig_h, orig_w = image.shape[:2]
    print(f"Image size: {orig_w}x{orig_h}")

    # Detection
    det_start = time.time()
    det_session = ort.InferenceSession(DETECTOR_PATH)
    tensor, scale, new_h, new_w = preprocess_detection(image)
    det_input = det_session.get_inputs()[0].name
    det_output = det_session.get_outputs()[0].name
    prob_map = det_session.run([det_output], {det_input: tensor})[0]
    if prob_map.ndim == 4:
        prob_map = prob_map[0, 0]
    elif prob_map.ndim == 3:
        prob_map = prob_map[0]
    det_time = time.time() - det_start

    polygons, confidences = extract_polygons(prob_map, scale, orig_h, orig_w, new_h, new_w)
    print(f"Detection: {len(polygons)} regions in {det_time*1000:.0f}ms")

    if not polygons:
        return []

    # Recognition
    rec_start = time.time()
    rec_session = ort.InferenceSession(RECOGNIZER_PATH)

    crops = []
    valid_polygons = []
    for poly in polygons:
        crop = four_point_transform(image, poly)
        if crop is not None and crop.shape[0] > 0 and crop.shape[1] > 0:
            crops.append(preprocess_recognition(crop))
            valid_polygons.append(poly)

    if not crops:
        return []

    batch = np.stack(crops, axis=0).astype(np.float32)
    rec_input = rec_session.get_inputs()[0].name
    rec_output = rec_session.get_outputs()[0].name
    logits = rec_session.run([rec_output], {rec_input: batch})[0]
    decoded = decode_parseq(logits)
    rec_time = time.time() - rec_start

    results = []
    for i, (text, conf) in enumerate(decoded):
        if text:
            results.append({"text": text, "confidence": conf})

    print(f"Recognition: {len(results)} words in {rec_time*1000:.0f}ms")
    for r in results:
        print(f"  '{r['text']}' (conf={r['confidence']:.4f})")
    print(f"Total: {(det_time+rec_time)*1000:.0f}ms")
    return results


def run_onnxtr_library(image_path):
    """Run the OnnxTR library for reference comparison."""
    print(f"\n{'='*60}")
    print(f"OnnxTR Library: {os.path.basename(image_path)}")
    print(f"{'='*60}")

    try:
        from onnxtr.io import DocumentFile
        from onnxtr.models import ocr_predictor

        start = time.time()
        predictor = ocr_predictor(
            det_arch="db_resnet50",
            reco_arch="parseq",
        )
        doc = DocumentFile.from_images(image_path)
        result = predictor(doc)
        elapsed = time.time() - start

        texts = []
        for page in result.pages:
            for block in page.blocks:
                for line in block.lines:
                    for word in line.words:
                        texts.append({
                            "text": word.value,
                            "confidence": word.confidence,
                        })

        print(f"OnnxTR: {len(texts)} words in {elapsed*1000:.0f}ms")
        for t in texts:
            print(f"  '{t['text']}' (conf={t['confidence']:.4f})")
        return texts
    except Exception as e:
        print(f"OnnxTR library error: {e}")
        import traceback
        traceback.print_exc()
        return []


def main():
    test_images = [
        str(ADDON_DIR / "test" / "images" / "basic_test.bmp"),
        str(ADDON_DIR / "test" / "images" / "basic_test.jpg"),
        str(ADDON_DIR / "test" / "images" / "english.bmp"),
    ]

    if not os.path.exists(DETECTOR_PATH):
        print(f"ERROR: Detector not found: {DETECTOR_PATH}")
        sys.exit(1)
    if not os.path.exists(RECOGNIZER_PATH):
        print(f"ERROR: Recognizer not found: {RECOGNIZER_PATH}")
        sys.exit(1)

    print("=" * 60)
    print("DocTR Python vs C++ Comparison")
    print("=" * 60)

    all_results = {}

    # C++ results from the test run (hardcoded for comparison)
    cpp_results = {
        "basic_test.bmp": ["normal", ":"],
        "basic_test.jpg": ["normal", ":"],
        "english.bmp": ["Organization", "Health", "World", "or", "animals", "farm",
                        "contact", "unprotected", "wild", "live", "wiith", "No",
                        "eggs", "horoughly", "meat", "and", "cook", "symptoms", "or",
                        "flu-like", "cold", "anyone", "rontact", "with", "with", "close",
                        "Avoid", "or", "sneezing", "elbow", "flexed", "tissue", "wiith",
                        "nose", "coughing", "mouth", "Cover", "and", "when", "and", "or",
                        "alronl-hacor", "hand", "rub", "soap", "water", "hands", "Clean",
                        "and", "wiith", "your", "coronavirue", "intection", "Reduce",
                        "risk", "off"],
    }

    # Run manual pipeline (matching C++ logic)
    print("\n\n*** MANUAL PIPELINE (matching C++ implementation) ***")
    for img_path in test_images:
        if os.path.exists(img_path):
            results = run_manual_pipeline(img_path)
            basename = os.path.basename(img_path)
            all_results[basename] = {"manual": results}

    # Run OnnxTR library
    print("\n\n*** ONNXTR LIBRARY (reference) ***")
    for img_path in test_images:
        if os.path.exists(img_path):
            basename = os.path.basename(img_path)
            results = run_onnxtr_library(img_path)
            if basename in all_results:
                all_results[basename]["onnxtr"] = results

    # Summary comparison
    print("\n\n" + "=" * 60)
    print("COMPARISON SUMMARY")
    print("=" * 60)

    for img_name in ["basic_test.bmp", "basic_test.jpg", "english.bmp"]:
        data = all_results.get(img_name, {})
        manual = [r["text"] for r in data.get("manual", [])]
        onnxtr = [r["text"] for r in data.get("onnxtr", [])]
        cpp = cpp_results.get(img_name, [])

        print(f"\n--- {img_name} ---")
        print(f"  C++ pipeline:    {len(cpp)} words -> {cpp[:10]}{'...' if len(cpp)>10 else ''}")
        print(f"  Python manual:   {len(manual)} words -> {manual[:10]}{'...' if len(manual)>10 else ''}")
        print(f"  OnnxTR library:  {len(onnxtr)} words -> {onnxtr[:10]}{'...' if len(onnxtr)>10 else ''}")

        # Compare C++ vs OnnxTR
        if onnxtr:
            cpp_set = set(cpp)
            onnxtr_set = set(onnxtr)
            common = cpp_set & onnxtr_set
            only_cpp = cpp_set - onnxtr_set
            only_onnxtr = onnxtr_set - cpp_set
            print(f"  C++ vs OnnxTR: {len(common)} common, {len(only_cpp)} only-C++, {len(only_onnxtr)} only-OnnxTR")
            if only_cpp:
                print(f"    Only in C++:    {sorted(only_cpp)[:15]}")
            if only_onnxtr:
                print(f"    Only in OnnxTR: {sorted(only_onnxtr)[:15]}")

    output_path = str(ADDON_DIR / "test" / "python_doctr_output.json")
    with open(output_path, "w") as f:
        json.dump(all_results, f, indent=2)
    print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
