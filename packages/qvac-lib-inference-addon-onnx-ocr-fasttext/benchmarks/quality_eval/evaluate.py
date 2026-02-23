#!/usr/bin/env python3
"""
OCR Quality Evaluation Framework

Benchmarks OCR backends (EasyOCR, QVAC) on the OCRBench_v2 dataset,
measuring accuracy (CER, WER, ANLS) and speed (inference time, throughput).

Usage:
    python evaluate.py --dataset-path /path/to/OCRBench_v2 --backends easyocr,qvac

Based on the translation benchmark framework pattern.
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Any, Optional
import statistics

import click
from tqdm import tqdm

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from dataset import OCRBenchLoader
from backends import EasyOCRBackend, QVACOCRBackend, OCRBackend, OCRResult
from metrics import compute_cer, compute_wer, compute_anls
from metrics.spotting import (
    evaluate_text_spotting, parse_gt_boxes, get_image_dimensions
)
from utils import format_duration


# Default task types for benchmarking
DEFAULT_TASK_TYPES = [
    "text spotting en",
]

# Text spotting task types (require special handling)
TEXT_SPOTTING_TASKS = ["text spotting en"]

# Available backends
AVAILABLE_BACKENDS = {
    "easyocr": EasyOCRBackend,
    "qvac": QVACOCRBackend,
}

# Available metrics
AVAILABLE_METRICS = {
    "cer": compute_cer,
    "wer": compute_wer,
    "anls": compute_anls,
}


def create_backend(name: str, **kwargs) -> OCRBackend:
    """Create an OCR backend by name.

    Args:
        name: Backend name (easyocr, qvac)
        **kwargs: Additional backend-specific arguments

    Returns:
        Initialized OCR backend
    """
    if name not in AVAILABLE_BACKENDS:
        raise ValueError(f"Unknown backend: {name}. Available: {list(AVAILABLE_BACKENDS.keys())}")

    backend_class = AVAILABLE_BACKENDS[name]
    return backend_class(**kwargs)


def compute_sample_metrics(
    prediction: str,
    ground_truth: str,
    all_answers: List[str],
    metric_names: List[str]
) -> Dict[str, float]:
    """Compute metrics for a single sample.

    Args:
        prediction: OCR output text
        ground_truth: Primary ground truth text
        all_answers: All acceptable answers
        metric_names: List of metrics to compute

    Returns:
        Dictionary of metric name to value
    """
    results = {}

    for metric_name in metric_names:
        if metric_name not in AVAILABLE_METRICS:
            continue

        metric_fn = AVAILABLE_METRICS[metric_name]

        if metric_name == "anls":
            # ANLS can use all acceptable answers
            results[metric_name] = metric_fn(prediction, all_answers)
        else:
            # CER/WER use primary ground truth
            results[metric_name] = metric_fn(prediction, ground_truth)

    return results


def save_sample_result(
    results_dir: Path,
    backend_name: str,
    task_type: str,
    sample_id: int,
    result: Dict[str, Any]
) -> None:
    """Save individual sample result to file.

    Args:
        results_dir: Base results directory
        backend_name: Name of the backend
        task_type: Task type (sanitized for filename)
        sample_id: Sample ID
        result: Result dictionary to save
    """
    # Sanitize task type for filename
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
    """Load existing result if available.

    Args:
        results_dir: Base results directory
        backend_name: Name of the backend
        task_type: Task type
        sample_id: Sample ID

    Returns:
        Result dictionary if exists, None otherwise
    """
    task_dir_name = task_type.replace(" ", "_")
    result_file = results_dir / backend_name / task_dir_name / f"sample_{sample_id}.json"

    if result_file.exists():
        with open(result_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


def compute_aggregate_metrics(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute aggregate statistics from sample results.

    Args:
        results: List of sample result dictionaries

    Returns:
        Aggregate statistics dictionary
    """
    if not results:
        return {}

    # Collect metric values
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

    # Compute statistics
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
    """Save aggregate results for a backend/task combination.

    Args:
        results_dir: Base results directory
        backend_name: Name of the backend
        task_type: Task type
        aggregate: Aggregate statistics
    """
    task_dir_name = task_type.replace(" ", "_")
    task_dir = results_dir / backend_name / task_dir_name
    task_dir.mkdir(parents=True, exist_ok=True)

    aggregate["backend"] = backend_name
    aggregate["task_type"] = task_type

    aggregate_file = task_dir / "aggregate.json"
    with open(aggregate_file, 'w', encoding='utf-8') as f:
        json.dump(aggregate, f, indent=2, ensure_ascii=False)


def print_summary(all_results: Dict[str, Dict[str, Dict[str, Any]]]) -> None:
    """Print summary of all results.

    Args:
        all_results: Nested dict of backend -> task_type -> aggregate
    """
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


@click.command()
@click.option(
    "--dataset-path",
    required=True,
    type=click.Path(exists=True),
    help="Path to OCRBench_v2 directory"
)
@click.option(
    "--backends",
    default="easyocr,qvac",
    help="Comma-separated list of backends to evaluate (easyocr,qvac)"
)
@click.option(
    "--task-types",
    default=None,
    help="Comma-separated task types to benchmark (default: text recognition tasks)"
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
    "--qvac-addon-path",
    default=None,
    type=click.Path(),
    help="Path to QVAC OCR addon directory"
)
@click.option(
    "--gpu/--no-gpu",
    default=False,
    help="Use GPU for backends that support it"
)
@click.option(
    "--dataset-filter",
    default=None,
    help="Filter samples by image_path containing this string (e.g., 'HierText')"
)
@click.option(
    "--model-dir",
    default="rec_dyn",
    help="Model directory name within models/ocr/ (default: rec_dyn)"
)
def main(
    dataset_path: str,
    backends: str,
    task_types: Optional[str],
    metrics: str,
    results_dir: str,
    skip_existing: bool,
    limit: int,
    qvac_addon_path: Optional[str],
    gpu: bool,
    dataset_filter: Optional[str],
    model_dir: str
):
    """OCR Quality Evaluation Framework.

    Benchmarks OCR backends on OCRBench_v2 dataset.
    """
    # Parse arguments
    backend_names = [b.strip() for b in backends.split(",")]
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

    # Store all results for summary
    all_results: Dict[str, Dict[str, Dict[str, Any]]] = {}

    # Evaluate each backend
    for backend_name in backend_names:
        print(f"\n{'=' * 60}")
        print(f"Evaluating backend: {backend_name}")
        print("=" * 60)

        all_results[backend_name] = {}

        # Create backend
        try:
            backend_kwargs = {"gpu": gpu}
            if backend_name == "qvac":
                backend_kwargs["model_dir"] = model_dir
                if qvac_addon_path:
                    backend_kwargs["addon_path"] = qvac_addon_path

            backend = create_backend(backend_name, **backend_kwargs)
            backend.initialize()
        except Exception as e:
            print(f"Error initializing {backend_name}: {e}")
            continue

        try:
            # Evaluate each task type
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

                # Use batch processing for QVAC backend
                if backend_name == "qvac" and hasattr(backend, 'run_ocr_batch') and samples_to_process:
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

                            # Process result (same as sequential)
                            boxes_data = []
                            for box in ocr_result.boxes:
                                points = []
                                for point in box.points:
                                    if hasattr(point, 'tolist'):
                                        points.append(point.tolist())
                                    else:
                                        points.append([float(p) for p in point])
                                boxes_data.append({
                                    "points": points,
                                    "text": box.text,
                                    "confidence": float(box.confidence)
                                })

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
                            save_sample_result(
                                results_path, backend_name, task_type, sample_id, result
                            )

                        # Skip the sequential loop
                        samples_to_process = []

                # Sequential processing (for EasyOCR or fallback)
                for sample in tqdm(samples_to_process, desc=f"    {backend_name}/{task_type}"):
                    sample_id = sample.get("id", 0)

                    # Get image path and ground truth
                    image_path = loader.get_image_path(sample)
                    ground_truth = loader.get_ground_truth(sample)
                    all_answers = loader.get_all_answers(sample)

                    # Run OCR
                    try:
                        ocr_result = backend.run_ocr(str(image_path))
                        prediction = ocr_result.text
                    except Exception as e:
                        print(f"\n    Error on sample {sample_id}: {e}")
                        prediction = ""
                        ocr_result = OCRResult(text="", inference_time=0)

                    # Convert bounding boxes to serializable format
                    boxes_data = []
                    for box in ocr_result.boxes:
                        # Convert numpy arrays/types to native Python types
                        points = []
                        for point in box.points:
                            if hasattr(point, 'tolist'):
                                points.append(point.tolist())
                            else:
                                points.append([float(p) for p in point])
                        boxes_data.append({
                            "points": points,
                            "text": box.text,
                            "confidence": float(box.confidence)
                        })

                    # Compute metrics based on task type
                    if task_type in TEXT_SPOTTING_TASKS:
                        # Text spotting: evaluate bounding boxes + text
                        img_width, img_height = get_image_dimensions(str(image_path))
                        gt_boxes = parse_gt_boxes(sample)
                        sample_metrics = evaluate_text_spotting(
                            boxes_data, gt_boxes, img_width, img_height
                        )
                        # Build result with spotting-specific data
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
                        # Text recognition: evaluate text accuracy
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

                    # Save individual result
                    save_sample_result(
                        results_path, backend_name, task_type, sample_id, result
                    )

                # Compute aggregate
                aggregate = compute_aggregate_metrics(task_results)
                save_aggregate_results(results_path, backend_name, task_type, aggregate)
                all_results[backend_name][task_type] = aggregate

        finally:
            backend.cleanup()

    # Print summary
    print_summary(all_results)

    # Save overall summary
    summary_file = results_path / "summary.json"
    with open(summary_file, 'w', encoding='utf-8') as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to {results_path}")


if __name__ == "__main__":
    main()
