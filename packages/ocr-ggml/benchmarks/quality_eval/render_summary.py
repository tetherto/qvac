#!/usr/bin/env python3
"""Render the OCR GGML benchmark step summary."""

import argparse
import json
from pathlib import Path

FULL_PAGE_TASK = "full-page OCR en"
SPOTTING_TASK = "text spotting en"
FULL_PAGE_DIR = "full-page-ocr"
SPOTTING_DIR = "text-spotting"

BACKENDS = [
    ("qvac-easyocr", "EasyOCR (CRAFT + latin_g2)", "QVAC GGML"),
    ("easyocr", "EasyOCR (CRAFT + latin_g2)", "Python reference"),
    ("qvac-doctr", "DocTR (DB MobileNetV3 + CRNN)", "QVAC GGML"),
    ("doctr", "DocTR (DB MobileNetV3 + CRNN)", "Python reference"),
]

DEVICE_ORDER = {"CPU": 0, "GPU": 1}

DEFAULT_PLATFORM = "linux-x64"
PLATFORM_ARTIFACT_PREFIX = "ocr-ggml-benchmark-results-"


def has_task_dirs(root):
    return (root / FULL_PAGE_DIR).is_dir() or (root / SPOTTING_DIR).is_dir()


def discover_platforms(results_dir):
    root = Path(results_dir)
    if has_task_dirs(root):
        return [(DEFAULT_PLATFORM, root)]
    platforms = []
    if root.is_dir():
        for child in sorted(root.iterdir()):
            if not child.is_dir() or not has_task_dirs(child):
                continue
            name = child.name
            if name.startswith(PLATFORM_ARTIFACT_PREFIX):
                name = name[len(PLATFORM_ARTIFACT_PREFIX):]
            platforms.append((name or DEFAULT_PLATFORM, child))
    return platforms


def comparison_root(platforms):
    for name, root in platforms:
        if name == DEFAULT_PLATFORM:
            return root
    return platforms[0][1] if platforms else None


def discover_aggregates(results_dir, task_dir, backend, task_type):
    base = Path(results_dir) / task_dir / backend
    task_leaf = task_type.replace(" ", "_")
    found = []
    if not base.is_dir():
        return found
    for path in sorted(base.rglob("aggregate.json")):
        rel = path.relative_to(base).parts
        if len(rel) == 2 and rel[0] == task_leaf:
            device = None
        elif len(rel) == 3 and rel[1] == task_leaf:
            device = rel[0].upper()
        else:
            continue
        with open(path) as f:
            agg = json.load(f)
        found.append((device or str(agg.get("device", "CPU")).upper(), agg))
    return found


def load_aggregate(results_dir, task_dir, backend, task_type):
    aggs = discover_aggregates(results_dir, task_dir, backend, task_type)
    for device, agg in aggs:
        if device == "CPU":
            return agg
    return aggs[0][1] if aggs else None


def metric_mean(agg, key):
    if not agg:
        return None
    return agg.get("metrics", {}).get(key, {}).get("mean")


def fmt_metric(agg, key):
    value = metric_mean(agg, key)
    return "-" if value is None else f"{value:.3f}"


def fmt_speed(agg):
    speed = agg.get("speed") if agg else None
    if not speed or speed.get("mean_time_per_image") is None:
        return "-"
    mean = speed["mean_time_per_image"]
    std = speed.get("std_time") or 0
    return f"{mean:.1f} ±{std:.1f}"


def fmt_samples(fp_agg, ts_agg):
    fp = fp_agg["total_samples"] if fp_agg else "-"
    ts = ts_agg["total_samples"] if ts_agg else "-"
    if fp == "-" and ts == "-":
        return "-"
    return f"{fp} / {ts}"


def pick_winner(val_a, val_b, name_a, name_b, lower_is_better=True):
    if val_a is None or val_b is None:
        return "N/A", "N/A", "-"
    a_wins = val_a < val_b if lower_is_better else val_a > val_b
    a_str = f"**{val_a:.4f}**" if a_wins else f"{val_a:.4f}"
    b_str = f"**{val_b:.4f}**" if not a_wins else f"{val_b:.4f}"
    return a_str, b_str, name_a if a_wins else name_b


def comparison_table(qvac, ref, qvac_name, ref_name, rows):
    lines = [
        f"| Metric | {qvac_name} | {ref_name} | Winner |",
        "|--------|-------------|----------------|--------|",
    ]
    for label, key, lower in rows:
        a, b, w = pick_winner(
            metric_mean(qvac, key), metric_mean(ref, key), qvac_name, ref_name, lower
        )
        lines.append(f"| {label} | {a} | {b} | {w} |")
    return lines


def speed_row(qvac, ref, qvac_name, ref_name):
    q_speed = qvac.get("speed") if qvac else None
    r_speed = ref.get("speed") if ref else None
    if not q_speed or not r_speed:
        return []
    qs = q_speed["mean_time_per_image"]
    rs = r_speed["mean_time_per_image"]
    speedup = rs / qs if qs > 0 else 0
    if qs < rs:
        winner = f"{qvac_name} ({speedup:.1f}x)"
    else:
        winner = f"{ref_name} ({1 / speedup:.1f}x)" if speedup else ref_name
    q_str = f"**{qs:.1f}s**" if qs < rs else f"{qs:.1f}s"
    r_str = f"**{rs:.1f}s**" if rs < qs else f"{rs:.1f}s"
    return [f"| Speed | {q_str}/img | {r_str}/img | {winner} |"]


FULL_PAGE_METRICS = [("CER ↓", "cer", True), ("WER ↓", "wer", True), ("ANLS ↑", "anls", False)]
SPOTTING_METRICS = [
    ("E2E F1 ↑", "e2e_f1", False),
    ("E2E Precision ↑", "e2e_precision", False),
    ("E2E Recall ↑", "e2e_recall", False),
    ("Detection F1 ↑", "det_f1", False),
    ("Avg CER ↓", "avg_cer", True),
    ("Avg ANLS ↑", "avg_anls", False),
]

COMPARISON_PAIRS = [
    ("qvac-easyocr", "easyocr", "QVAC EasyOCR", "EasyOCR Python", "EasyOCR pipeline vs Python EasyOCR"),
    ("qvac-doctr", "doctr", "QVAC DocTR", "DocTR Python", "DocTR pipeline vs python-doctr"),
]


def comparison_sections(results_dir, pipeline):
    run_easyocr = pipeline in ("easyocr", "both")
    run_doctr = pipeline in ("doctr", "both")
    lines = []
    for title, task_dir, task_type, metric_rows, with_speed in [
        ("## Full-page OCR (HierText)", FULL_PAGE_DIR, FULL_PAGE_TASK, FULL_PAGE_METRICS, True),
        ("## Text Spotting (IC15)", SPOTTING_DIR, SPOTTING_TASK, SPOTTING_METRICS, False),
    ]:
        lines.append(title)
        lines.append("")
        for qvac_be, ref_be, qvac_name, ref_name, heading in COMPARISON_PAIRS:
            if qvac_be == "qvac-easyocr" and not run_easyocr:
                continue
            if qvac_be == "qvac-doctr" and not run_doctr:
                continue
            qvac = load_aggregate(results_dir, task_dir, qvac_be, task_type)
            ref = load_aggregate(results_dir, task_dir, ref_be, task_type)
            if not qvac or not ref:
                continue
            lines.append(f"### {heading}")
            lines.append("")
            lines.extend(comparison_table(qvac, ref, qvac_name, ref_name, metric_rows))
            if with_speed:
                lines.extend(speed_row(qvac, ref, qvac_name, ref_name))
            lines.append("")
            lines.append(f"*Samples: {qvac['total_samples']}*")
            lines.append("")
    return lines


def summary_table(platforms):
    rows = {}
    for platform, root in platforms:
        for backend, model, backend_label in BACKENDS:
            for task_dir, task_type, slot in [
                (FULL_PAGE_DIR, FULL_PAGE_TASK, "fp"),
                (SPOTTING_DIR, SPOTTING_TASK, "ts"),
            ]:
                for device, agg in discover_aggregates(root, task_dir, backend, task_type):
                    key = (backend, platform, device)
                    if key not in rows:
                        rows[key] = {"model": model, "backend_label": backend_label, "fp": None, "ts": None}
                    rows[key][slot] = agg

    if not rows:
        return ["_No results found — nothing to summarize._"]

    order = {backend: i for i, (backend, _, _) in enumerate(BACKENDS)}
    lines = [
        "## Summary — All Models",
        "",
        (
            "> Full-page OCR (HierText) + Text Spotting (IC15) stats per model, "
            + "backend, platform and device. _`-` = not run in this configuration._"
        ),
        "",
        (
            "| Model | Backend | Platform | Device | Samples (FP/TS) | CER ↓ | WER ↓ | ANLS ↑ "
            + "| FP Speed (s/img) | E2E F1 ↑ | Det F1 ↑ | Avg CER ↓ | Avg ANLS ↑ "
            + "| TS Speed (s/img) |"
        ),
        (
            "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: "
            + "| ---: | ---: | ---: |"
        ),
    ]
    for backend, platform, device in sorted(
        rows,
        key=lambda k: (order.get(k[0], len(order)), k[1], DEVICE_ORDER.get(k[2], 2), k[2]),
    ):
        row = rows[(backend, platform, device)]
        fp, ts = row["fp"], row["ts"]
        cells = [
            row["model"],
            row["backend_label"],
            platform,
            device,
            fmt_samples(fp, ts),
            fmt_metric(fp, "cer"),
            fmt_metric(fp, "wer"),
            fmt_metric(fp, "anls"),
            fmt_speed(fp),
            fmt_metric(ts, "e2e_f1"),
            fmt_metric(ts, "det_f1"),
            fmt_metric(ts, "avg_cer"),
            fmt_metric(ts, "avg_anls"),
            fmt_speed(ts),
        ]
        lines.append("| " + " | ".join(cells) + " |")
    lines.append("")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", required=True, help="Results directory")
    parser.add_argument("--pipeline", default="both", help="Pipeline(s) evaluated")
    parser.add_argument("--tasks", default="fullpage,spotting", help="Tasks that ran")
    parser.add_argument("--limit", default="0", help="Sample limit (0 = all)")
    args = parser.parse_args()

    lines = [
        "# OCR GGML Benchmark Results",
        "",
        "**Configuration:**",
        f"- Pipeline: `{args.pipeline}`",
        f"- Tasks: `{args.tasks}`",
        f"- Sample Limit: `{args.limit}`",
        "",
    ]
    platforms = discover_platforms(args.results)
    reference_root = comparison_root(platforms)
    if reference_root is not None:
        lines.extend(comparison_sections(reference_root, args.pipeline))
    lines.extend(summary_table(platforms))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
