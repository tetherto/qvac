#!/usr/bin/env python3
"""
OCR Quality Evaluation Framework for ocr-ggml

Benchmarks QVAC OCR GGML backends (easyocr pipeline, doctr pipeline) against
their respective Python reference implementations (EasyOCR, python-doctr) on
the OCRBench_v2 dataset.

Usage:
    python evaluate.py --dataset-path /path/to/OCRBench_v2 \\
        --pipeline both \\
        --detector /path/to/craft_mlt_25k.gguf \\
        --recognizer /path/to/latin_g2.gguf \\
        --doctr-detector /path/to/db_mobilenet_v3_large.gguf \\
        --doctr-recognizer /path/to/crnn_mobilenet_v3_small.gguf
"""

import json
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional
import statistics

import click
from tqdm import tqdm

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from dataset import OCRBenchLoader
from backends import EasyOCRBackend, DocTRBackend, QVACOCRGgmlBackend, OCRBackend, OCRResult
from metrics import compute_cer, compute_wer, compute_anls
from metrics.spotting import (
    evaluate_text_spotting, parse_gt_boxes, get_image_dimensions
)


# Default task types for benchmarking
DEFAULT_TASK_TYPES = [
    "text spotting en",
]

# Text spotting task types (require special handling)
TEXT_SPOTTING_TASKS = ["text spotting en"]

# Available metrics
AVAILABLE_METRICS = {
    "cer": compute_cer,
    "wer": compute_wer,
    "anls": compute_anls,
}


def compute_sample_metrics(
    prediction: str,
    ground_truth: str,
    all_answers: List[str],
    metric_names: List[str]
) -> Dict[str, float]:
    """Compute metrics for a single sample."""
    results = {}

    for metric_name in metric_names:
        if metric_name not in AVAILABLE_METRICS:
            continue

        metric_fn = AVAILABLE_METRICS[metric_name]

        if metric_name == "anls":
            results[metric_name] = metric_fn(prediction, all_answers)
        else:
            results[metric_name] = metric_fn(prediction, ground_truth)

    return results


def save_sample_result(
    results_dir: Path,
    backend_name: str,
    task_type: str,
    sample_id: int,
    result: Dict[str, Any]
) -> None:
    """Save individual sample result to file."""
    task_dir_name = task_type.replace(" ", "_")
    task_dir = results_dir / backend_name / task_dir_name
    task_dir.mkdir(parents=True, exist_ok=True)

    result_file = task_dir / f"sample_{sample_id}.json"
    with open(result_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)


def load_existing_result(
    results_dir: Path,
    backend_name: str,
    task_type: str,
    sample_id: int
) -> Optional[Dict[str, Any]]:
    """Load existing result if available."""
    task_dir_name = task_type.replace(" ", "_")
    result_file = results_dir / backend_name / task_dir_name / f"sample_{sample_id}.json"

    if result_file.exists():
        with open(result_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


def compute_aggregate_metrics(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute aggregate statistics from sample results."""
    if not results:
        return {}

    metric_values: Dict[str, List[float]] = {}
    inference_times: List[float] = []

    for result in results:
        if "metrics" in result:
            for metric_name, value in result["metrics"].items():
                if metric_name not in metric_values:
                    metric_values[metric_name] = []
                metric_values[metric_name].append(value)

        if "inference_time" in result:
            inference_times.append(result["inference_time"])

    aggregate = {
        "total_samples": len(results),
        "metrics": {},
        "speed": {}
    }

    for metric_name, values in metric_values.items():
        aggregate["metrics"][metric_name] = {
            "mean": statistics.mean(values),
            "std": statistics.stdev(values) if len(values) > 1 else 0.0,
            "min": min(values),
            "max": max(values),
        }

    if inference_times:
        total_time = sum(inference_times)
        aggregate["speed"] = {
            "total_time": total_time,
            "mean_time_per_image": statistics.mean(inference_times),
            "std_time": statistics.stdev(inference_times) if len(inference_times) > 1 else 0.0,
            "throughput_images_per_sec": len(inference_times) / total_time if total_time > 0 else 0.0,
        }

    return aggregate


def save_aggregate_results(
    results_dir: Path,
    backend_name: str,
    task_type: str,
    aggregate: Dict[str, Any]
) -> None:
    """Save aggregate results for a backend/task combination."""
    task_dir_name = task_type.replace(" ", "_")
    task_dir = results_dir / backend_name / task_dir_name
    task_dir.mkdir(parents=True, exist_ok=True)

    aggregate["backend"] = backend_name
    aggregate["task_type"] = task_type

    aggregate_file = task_dir / "aggregate.json"
    with open(aggregate_file, 'w', encoding='utf-8') as f:
        json.dump(aggregate, f, indent=2, ensure_ascii=False)


def print_summary(all_results: Dict[str, Dict[str, Dict[str, Any]]]) -> None:
    """Print summary of all results."""
    print("\n" + "=" * 80)
    print("EVALUATION SUMMARY")
    print("=" * 80)

    for backend_name, task_results in all_results.items():
        print(f"\n{backend_name.upper()}")
        print("-" * 40)

        for task_type, aggregate in task_results.items():
            print(f"\n  Task: {task_type}")
            print(f"  Samples: {aggregate.get('total_samples', 0)}")

            if "metrics" in aggregate:
                print("  Metrics:")
                for metric_name, stats in aggregate["metrics"].items():
                    print(f"    {metric_name}: {stats['mean']:.4f} (±{stats['std']:.4f})")

            if "speed" in aggregate:
                speed = aggregate["speed"]
                print(f"  Speed:")
                print(f"    Mean time/image: {speed.get('mean_time_per_image', 0):.3f}s")
                print(f"    Throughput: {speed.get('throughput_images_per_sec', 0):.2f} img/s")

    print("\n" + "=" * 80)


def evaluate_backend(
    backend: OCRBackend,
    backend_name: str,
    loader: OCRBenchLoader,
    task_type_list: List[str],
    metric_names: List[str],
    results_path: Path,
    skip_existing: bool,
    limit: int,
    dataset_filter: Optional[str]
) -> Dict[str, Dict[str, Any]]:
    """Run evaluation for one backend across all task types."""
    backend_results: Dict[str, Dict[str, Any]] = {}

    for task_type in task_type_list:
        print(f"\n  Task type: {task_type}")

        # Get samples for this task type
        samples = loader.filter_by_task_types([task_type])

        # Apply dataset filter if specified
        if dataset_filter:
            samples = [s for s in samples if dataset_filter in s.get("image_path", "")]
            print(f"    Filtered to {len(samples)} samples containing '{dataset_filter}'")

        if limit > 0:
            samples = samples[:limit]

        if not samples:
            print(f"    No samples found for {task_type}")
            continue

        # Validate images exist
        validation = loader.validate_images(samples)
        valid_samples = validation["valid"]
        missing_count = len(validation["missing"])

        if missing_count > 0:
            print(f"    Warning: {missing_count} images not found")

        if not valid_samples:
            print(f"    No valid samples with existing images")
            continue

        # Evaluate samples
        task_results = []
        skipped = 0

        # Separate samples into existing and new
        samples_to_process = []
        for sample in valid_samples:
            sample_id = sample.get("id", 0)
            if skip_existing:
                existing = load_existing_result(
                    results_path, backend_name, task_type, sample_id
                )
                if existing:
                    task_results.append(existing)
                    skipped += 1
                    continue
            samples_to_process.append(sample)

        if skipped > 0:
            print(f"    Skipped {skipped} existing results")

        # Use batch processing for QVAC GGML backends
        if isinstance(backend, QVACOCRGgmlBackend) and samples_to_process:
            print(f"    Processing {len(samples_to_process)} samples in batch mode...")
            image_paths = [str(loader.get_image_path(s)) for s in samples_to_process]

            try:
                ocr_results = backend.run_ocr_batch(image_paths)
            except Exception as e:
                print(f"\n    Batch error: {e}, falling back to sequential")
                ocr_results = None

            if ocr_results:
                for sample, ocr_result in tqdm(
                    zip(samples_to_process, ocr_results),
                    total=len(samples_to_process),
                    desc=f"    {backend_name}/{task_type}"
                ):
                    sample_id = sample.get("id", 0)
                    image_path = loader.get_image_path(sample)
                    ground_truth = loader.get_ground_truth(sample)
                    all_answers = loader.get_all_answers(sample)
                    prediction = ocr_result.text

                    boxes_data = _boxes_to_serializable(ocr_result.boxes)

                    if task_type in TEXT_SPOTTING_TASKS:
                        img_width, img_height = get_image_dimensions(str(image_path))
                        gt_boxes = parse_gt_boxes(sample)
                        sample_metrics = evaluate_text_spotting(
                            boxes_data, gt_boxes, img_width, img_height
                        )
                        result = {
                            "id": sample_id,
                            "dataset_name": sample.get("dataset_name", ""),
                            "type": task_type,
                            "image_path": str(sample.get("image_path", "")),
                            "gt_boxes": [{"bbox": list(b[0]), "text": b[1]} for b in gt_boxes],
                            "pred_boxes": boxes_data,
                            "metrics": sample_metrics,
                            "inference_time": ocr_result.inference_time,
                        }
                    else:
                        sample_metrics = compute_sample_metrics(
                            prediction, ground_truth, all_answers, metric_names
                        )
                        result = {
                            "id": sample_id,
                            "dataset_name": sample.get("dataset_name", ""),
                            "type": task_type,
                            "image_path": str(sample.get("image_path", "")),
                            "ground_truth": ground_truth,
                            "prediction": prediction,
                            "boxes": boxes_data,
                            "metrics": sample_metrics,
                            "inference_time": ocr_result.inference_time,
                            "confidence": ocr_result.confidence,
                        }

                    task_results.append(result)
                    save_sample_result(results_path, backend_name, task_type, sample_id, result)

                # Skip the sequential loop
                samples_to_process = []

        # Sequential processing (for Python reference backends or fallback)
        for sample in tqdm(samples_to_process, desc=f"    {backend_name}/{task_type}"):
            sample_id = sample.get("id", 0)

            image_path = loader.get_image_path(sample)
            ground_truth = loader.get_ground_truth(sample)
            all_answers = loader.get_all_answers(sample)

            try:
                ocr_result = backend.run_ocr(str(image_path))
                prediction = ocr_result.text
            except Exception as e:
                print(f"\n    Error on sample {sample_id}: {e}")
                prediction = ""
                ocr_result = OCRResult(text="", inference_time=0)

            boxes_data = _boxes_to_serializable(ocr_result.boxes)

            if task_type in TEXT_SPOTTING_TASKS:
                img_width, img_height = get_image_dimensions(str(image_path))
                gt_boxes = parse_gt_boxes(sample)
                sample_metrics = evaluate_text_spotting(
                    boxes_data, gt_boxes, img_width, img_height
                )
                result = {
                    "id": sample_id,
                    "dataset_name": sample.get("dataset_name", ""),
                    "type": task_type,
                    "image_path": str(sample.get("image_path", "")),
                    "gt_boxes": [{"bbox": list(b[0]), "text": b[1]} for b in gt_boxes],
                    "pred_boxes": boxes_data,
                    "metrics": sample_metrics,
                    "inference_time": ocr_result.inference_time,
                }
            else:
                sample_metrics = compute_sample_metrics(
                    prediction, ground_truth, all_answers, metric_names
                )
                result = {
                    "id": sample_id,
                    "dataset_name": sample.get("dataset_name", ""),
                    "type": task_type,
                    "image_path": str(sample.get("image_path", "")),
                    "ground_truth": ground_truth,
                    "prediction": prediction,
                    "boxes": boxes_data,
                    "metrics": sample_metrics,
                    "inference_time": ocr_result.inference_time,
                    "confidence": ocr_result.confidence,
                }

            task_results.append(result)
            save_sample_result(results_path, backend_name, task_type, sample_id, result)

        # Compute and save aggregate
        aggregate = compute_aggregate_metrics(task_results)
        save_aggregate_results(results_path, backend_name, task_type, aggregate)
        backend_results[task_type] = aggregate

    return backend_results


def _boxes_to_serializable(boxes) -> list:
    """Convert BoundingBox list to JSON-serializable dicts."""
    result = []
    for box in boxes:
        points = []
        for point in box.points:
            if hasattr(point, 'tolist'):
                points.append(point.tolist())
            else:
                points.append([float(p) for p in point])
        result.append({
            "points": points,
            "text": box.text,
            "confidence": float(box.confidence)
        })
    return result


@click.command()
@click.option(
    "--dataset-path",
    required=True,
    type=click.Path(exists=True),
    help="Path to OCRBench_v2 directory"
)
@click.option(
    "--pipeline",
    default="both",
    type=click.Choice(["easyocr", "doctr", "both"]),
    help="GGML pipeline(s) to evaluate (easyocr, doctr, or both)"
)
@click.option(
    "--detector",
    default=None,
    type=click.Path(),
    help="Path to EasyOCR CRAFT detector GGUF"
)
@click.option(
    "--recognizer",
    default=None,
    type=click.Path(),
    help="Path to EasyOCR CRNN recognizer GGUF"
)
@click.option(
    "--doctr-detector",
    default=None,
    type=click.Path(),
    help="Path to DocTR detector GGUF"
)
@click.option(
    "--doctr-recognizer",
    default=None,
    type=click.Path(),
    help="Path to DocTR CRNN recognizer GGUF"
)
@click.option(
    "--task-types",
    default=None,
    help="Comma-separated task types to benchmark (default: text spotting tasks)"
)
@click.option(
    "--metrics",
    default="cer,wer,anls",
    help="Comma-separated metrics to compute (cer,wer,anls)"
)
@click.option(
    "--results-dir",
    default="results",
    type=click.Path(),
    help="Directory to store results"
)
@click.option(
    "--skip-existing/--no-skip-existing",
    default=True,
    help="Skip samples that already have results"
)
@click.option(
    "--limit",
    default=0,
    type=int,
    help="Limit number of samples per task type (0 = all)"
)
@click.option(
    "--gpu/--no-gpu",
    default=False,
    help="Use GPU for Python reference backends"
)
@click.option(
    "--dataset-filter",
    default=None,
    help="Filter samples by image_path containing this string (e.g., 'HierText')"
)
@click.option(
    "--qvac-addon-path",
    default=None,
    type=click.Path(),
    help="Path to QVAC OCR GGML addon directory (default: auto-detected)"
)
def main(
    dataset_path: str,
    pipeline: str,
    detector: Optional[str],
    recognizer: Optional[str],
    doctr_detector: Optional[str],
    doctr_recognizer: Optional[str],
    task_types: Optional[str],
    metrics: str,
    results_dir: str,
    skip_existing: bool,
    limit: int,
    gpu: bool,
    dataset_filter: Optional[str],
    qvac_addon_path: Optional[str]
):
    """OCR Quality Evaluation Framework for ocr-ggml.

    Evaluates QVAC OCR GGML backends against Python reference implementations.
    """
    metric_names = [m.strip() for m in metrics.split(",")]

    if task_types:
        task_type_list = [t.strip() for t in task_types.split(",")]
    else:
        task_type_list = DEFAULT_TASK_TYPES

    results_path = Path(results_dir)
    results_path.mkdir(parents=True, exist_ok=True)

    # Load dataset
    print(f"Loading dataset from {dataset_path}...")
    loader = OCRBenchLoader(dataset_path)
    try:
        total_samples = loader.load()
        print(f"Loaded {total_samples} samples")
    except FileNotFoundError as e:
        print(f"Error: {e}")
        sys.exit(1)

    # Get task type counts
    task_counts = loader.get_task_type_counts()
    print("\nTask type distribution:")
    for task_type in task_type_list:
        count = task_counts.get(task_type, 0)
        print(f"  {task_type}: {count} samples")

    # Determine which backend pairs to run
    backend_pairs = []  # [(backend_instance, name), ...]

    run_easyocr = pipeline in ("easyocr", "both")
    run_doctr = pipeline in ("doctr", "both")

    if run_easyocr:
        if not detector or not recognizer:
            print("Error: --detector and --recognizer are required for easyocr pipeline")
            sys.exit(1)
        backend_pairs.append((
            QVACOCRGgmlBackend(
                detector_path=detector,
                recognizer_path=recognizer,
                pipeline="easyocr",
                addon_path=qvac_addon_path
            ),
            "qvac-easyocr"
        ))
        backend_pairs.append((EasyOCRBackend(gpu=gpu), "easyocr"))

    if run_doctr:
        if not doctr_detector or not doctr_recognizer:
            print("Error: --doctr-detector and --doctr-recognizer are required for doctr pipeline")
            sys.exit(1)
        backend_pairs.append((
            QVACOCRGgmlBackend(
                detector_path=doctr_detector,
                recognizer_path=doctr_recognizer,
                pipeline="doctr",
                addon_path=qvac_addon_path
            ),
            "qvac-doctr"
        ))
        backend_pairs.append((DocTRBackend(gpu=gpu), "doctr"))

    # Store all results for summary
    all_results: Dict[str, Dict[str, Dict[str, Any]]] = {}
    failed_backends: List[str] = []

    for backend, backend_name in backend_pairs:
        print(f"\n{'=' * 60}")
        print(f"Evaluating backend: {backend_name}")
        print("=" * 60)

        all_results[backend_name] = {}

        try:
            backend.initialize()
        except Exception as e:
            print(f"Error initializing {backend_name}: {e}", file=sys.stderr)
            failed_backends.append(backend_name)
            continue

        try:
            backend_results = evaluate_backend(
                backend, backend_name, loader, task_type_list,
                metric_names, results_path, skip_existing, limit, dataset_filter
            )
            all_results[backend_name] = backend_results
        finally:
            backend.cleanup()

    # Print summary
    print_summary(all_results)

    # Save overall summary
    summary_file = results_path / "summary.json"
    with open(summary_file, 'w', encoding='utf-8') as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to {results_path}")

    if failed_backends:
        print(
            f"\nError: {len(failed_backends)} backend(s) failed to initialize: "
            f"{', '.join(failed_backends)}",
            file=sys.stderr
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
