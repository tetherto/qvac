#!/usr/bin/env python3
"""
Ground Truth conversion between our format and labelme.

Subcommands:
    export   Bootstrap from DocTR output (or existing GT) → labelme JSON
    import   Convert labelme JSON → ground_truth.json

Workflow:
    1.  python examples/gt-annotate.py export
    2.  labelme test/images/lab_results.png
        (edit annotations in the GUI, then File → Save)
    3.  python examples/gt-annotate.py import
"""

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(SCRIPT_DIR)
IMAGE_PATH = os.path.join(PKG_DIR, "test", "images", "lab_results.png")
LABELME_JSON = os.path.join(PKG_DIR, "test", "images", "lab_results.json")
GT_PATH = os.path.join(PKG_DIR, "test", "images", "ground_truth.json")
DOCTR_PATH = os.path.join(PKG_DIR, "test", "output", "demo_doctr.json")


def bbox_bounds(bbox):
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return min(xs), min(ys), max(xs), max(ys)


def bbox_center(bbox):
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def reading_order_key(ann):
    cx, cy = bbox_center(ann["bbox"])
    return (int(cy / 30), cx)


def export_to_labelme():
    """Create a labelme JSON next to the image, bootstrapped from model output."""
    from PIL import Image

    img = Image.open(IMAGE_PATH)
    img_w, img_h = img.size

    annotations = []

    if os.path.exists(GT_PATH):
        with open(GT_PATH) as f:
            data = json.load(f)
        annotations = data.get("annotations", [])
        print(f"Loaded existing ground truth: {len(annotations)} annotations")
    elif os.path.exists(DOCTR_PATH):
        with open(DOCTR_PATH) as f:
            data = json.load(f)
        for r in data.get("results", []):
            conf = r.get("confidence", 0)
            text = r.get("text", "").strip()
            if conf < 0.3 or not text:
                continue
            bbox = [[round(p[0], 1), round(p[1], 1)] for p in r["bbox"]]
            annotations.append({"text": text, "bbox": bbox})
        annotations.sort(key=reading_order_key)
        print(f"Bootstrapped {len(annotations)} annotations from DocTR output")
    else:
        print("No source data found. Creating empty labelme file.")

    shapes = []
    for ann in annotations:
        x1, y1, x2, y2 = bbox_bounds(ann["bbox"])
        shapes.append({
            "label": ann["text"],
            "points": [[x1, y1], [x2, y2]],
            "group_id": None,
            "shape_type": "rectangle",
            "flags": {},
        })

    labelme_data = {
        "version": "5.11.3",
        "flags": {},
        "shapes": shapes,
        "imagePath": os.path.basename(IMAGE_PATH),
        "imageData": None,
        "imageHeight": img_h,
        "imageWidth": img_w,
    }

    with open(LABELME_JSON, "w", encoding="utf-8") as f:
        json.dump(labelme_data, f, indent=2, ensure_ascii=False)

    print(f"Exported {len(shapes)} annotations to: {LABELME_JSON}")
    print()
    print("Now open labelme to review and edit:")
    print(f'  labelme "{IMAGE_PATH}"')
    print()
    print("After editing, save in labelme (Ctrl+S), then run:")
    print("  python examples/gt-annotate.py import")


def import_from_labelme():
    """Convert labelme JSON back to our ground_truth.json format."""
    if not os.path.exists(LABELME_JSON):
        print(f"Labelme JSON not found: {LABELME_JSON}")
        print("Open labelme, annotate, and save first.")
        sys.exit(1)

    with open(LABELME_JSON, encoding="utf-8") as f:
        data = json.load(f)

    img_w = data.get("imageWidth", 0)
    img_h = data.get("imageHeight", 0)

    annotations = []
    next_id = 1
    for shape in data.get("shapes", []):
        text = shape.get("label", "").strip()
        if not text:
            continue

        pts = shape["points"]
        shape_type = shape.get("shape_type", "rectangle")

        if shape_type == "rectangle" and len(pts) == 2:
            x1, y1 = pts[0]
            x2, y2 = pts[1]
            x1, x2 = min(x1, x2), max(x1, x2)
            y1, y2 = min(y1, y2), max(y1, y2)
        elif len(pts) >= 4:
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
        else:
            continue

        bbox = [
            [round(x1, 1), round(y1, 1)],
            [round(x2, 1), round(y1, 1)],
            [round(x2, 1), round(y2, 1)],
            [round(x1, 1), round(y2, 1)],
        ]
        annotations.append({"id": next_id, "text": text, "bbox": bbox})
        next_id += 1

    annotations.sort(key=reading_order_key)
    for i, ann in enumerate(annotations):
        ann["id"] = i + 1

    os.makedirs(os.path.dirname(GT_PATH), exist_ok=True)
    gt_data = {
        "image_path": "test/images/lab_results.png",
        "image_width": img_w,
        "image_height": img_h,
        "annotations": annotations,
    }
    with open(GT_PATH, "w", encoding="utf-8") as f:
        json.dump(gt_data, f, indent=2, ensure_ascii=False)

    print(f"Imported {len(annotations)} annotations from labelme")
    print(f"Saved to: {GT_PATH}")
    print()
    print("Now run the accuracy comparison:")
    print("  python examples/demo-accuracy.py")


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("export", "import"):
        print(__doc__)
        print("Usage:")
        print("  python examples/gt-annotate.py export   # Bootstrap → labelme JSON")
        print("  python examples/gt-annotate.py import   # labelme JSON → ground truth")
        sys.exit(1)

    if sys.argv[1] == "export":
        export_to_labelme()
    else:
        import_from_labelme()


if __name__ == "__main__":
    main()
