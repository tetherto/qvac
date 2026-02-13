#!/usr/bin/env python3
"""
Generate benchmark input texts from MTEB datasets.

This mirrors the existing benchmark client data-loading approach by reusing
`benchmarks/client/utils.py` and `load_mteb_tasks(...)`.
"""

import argparse
import json
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
CLIENT_DIR = ROOT_DIR.parent / "client"
sys.path.insert(0, str(CLIENT_DIR))
try:
    from utils import AVAILABLE_DATASETS, load_mteb_tasks  # noqa: E402
except Exception as error:
    raise RuntimeError(
        "Failed to import benchmark client utilities. "
        "Run this using the same Python env as benchmarks/client (Python 3.10+)."
    ) from error


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export MTEB query texts for JS parameter sweep inputs."
    )
    parser.add_argument(
        "--datasets",
        type=str,
        default="SciFact,NFCorpus,ArguAna",
        help="Comma-separated MTEB dataset names (default: SciFact,NFCorpus,ArguAna).",
    )
    parser.add_argument(
        "--samples-per-dataset",
        type=int,
        default=4,
        help="Number of query samples per dataset (default: 4).",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=str(ROOT_DIR / "mteb-inputs.json"),
        help="Output JSON file path.",
    )
    return parser.parse_args()


def extract_query_text(query):
    if isinstance(query, str):
        return query.strip()

    if isinstance(query, dict):
        text = query.get("text")
        if isinstance(text, str):
            return text.strip()

    return ""


def collect_query_texts(task):
    if task.dataset is None:
        raise RuntimeError(f"Task {task.metadata.name} has no dataset after load_mteb_tasks")

    texts = []
    seen = set()

    for subset in task.dataset.values():
        for split in subset.values():
            queries = split.get("queries")
            if queries is None:
                continue

            for query in queries:
                text = extract_query_text(query)
                if not text or text in seen:
                    continue
                seen.add(text)
                texts.append(text)

    return texts


def main():
    args = parse_args()

    datasets = [name.strip() for name in args.datasets.split(",") if name.strip()]
    if not datasets:
        raise ValueError("At least one dataset must be provided via --datasets")

    unknown = [name for name in datasets if name not in AVAILABLE_DATASETS]
    if unknown:
        print(
            f"Warning: unknown datasets in --datasets: {unknown}. "
            "Will still attempt to load them."
        )

    if args.samples_per_dataset <= 0:
        raise ValueError("--samples-per-dataset must be a positive integer")

    tasks = load_mteb_tasks(datasets, num_samples=args.samples_per_dataset)

    inputs = []
    for task in tasks:
        inputs.extend(collect_query_texts(task))

    if not inputs:
        raise RuntimeError("No input texts collected from MTEB tasks")

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(inputs, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {len(inputs)} MTEB input texts to {output_path}")


if __name__ == "__main__":
    main()
