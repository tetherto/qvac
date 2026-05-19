#!/usr/bin/env python3
"""
Quick 100-image benchmark comparing EasyOCR and DocTR GGML pipelines
against their Python reference implementations.
"""

import os
import sys
import time
import json
import subprocess
import tempfile
import glob
from pathlib import Path

import click

QVAC_DIR = Path(__file__).parent.parent.parent
BATCH_CLI = Path(__file__).parent / "ocr_batch_cli.js"


def find_images(directory, limit=100):
    """Find image files in directory."""
    images = []
    for ext in ['*.jpg', '*.jpeg', '*.png']:
        images.extend(glob.glob(os.path.join(directory, '**', ext), recursive=True))
        if len(images) >= limit:
            break
    return images[:limit]


def run_reference_benchmark(images, name, init_fn, infer_fn):
    """Run a Python reference backend benchmark."""
    print(f"\n{'='*60}")
    print(f"Running {name} benchmark...")
    print(f"{'='*60}")

    start_init = time.time()
    reader = init_fn()
    init_time = time.time() - start_init
    print(f"{name} initialization: {init_time:.2f}s")

    times = []
    total_regions = 0

    start_total = time.time()
    for i, img_path in enumerate(images):
        start = time.time()
        try:
            results = infer_fn(reader, img_path)
            total_regions += len(results)
        except Exception as e:
            print(f"  Error on {img_path}: {e}")
        elapsed = time.time() - start
        times.append(elapsed)

        if (i + 1) % 10 == 0:
            print(f"  Progress: {i+1}/{len(images)} images, last: {elapsed:.2f}s")

    total_time = time.time() - start_total

    print(f"\n{name} Results:")
    print(f"  Total images: {len(images)}")
    print(f"  Total regions detected: {total_regions}")
    print(f"  Total OCR time: {total_time:.2f}s")
    print(f"  Avg time per image: {total_time/len(images):.2f}s")
    print(f"  Init time: {init_time:.2f}s")

    return {
        'backend': name,
        'images': len(images),
        'regions': total_regions,
        'total_time': total_time,
        'init_time': init_time,
        'avg_time': total_time / len(images),
        'times': times
    }


def run_ggml_benchmark(images, name, detector, recognizer, pipeline):
    """Run a QVAC GGML batch benchmark."""
    print(f"\n{'='*60}")
    print(f"Running QVAC {name} GGML benchmark...")
    print(f"{'='*60}")

    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        for img in images:
            f.write(img + '\n')
        input_file = f.name

    output_fd = tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False)
    output_file = output_fd.name
    output_fd.close()

    try:
        start_total = time.time()
        result = subprocess.run(
            ['bare', str(BATCH_CLI),
             '--input', input_file,
             '--output', output_file,
             '--detector', detector,
             '--recognizer', recognizer,
             '--pipeline', pipeline],
            cwd=str(QVAC_DIR),
            capture_output=True,
            text=True
        )
        total_time = time.time() - start_total

        # Parse stderr for progress
        init_time = 0
        for line in result.stderr.split('\n'):
            if line.startswith('MODEL_READY:'):
                init_time = float(line.split(':')[1]) / 1000

        # Parse results
        total_regions = 0
        times = []
        if os.path.exists(output_file):
            with open(output_file) as f:
                for line in f:
                    try:
                        data = json.loads(line.strip())
                        if 'boxes' in data:
                            total_regions += len(data['boxes'])
                        if 'time_ms' in data:
                            times.append(data['time_ms'] / 1000)
                    except Exception:
                        pass

        label = f"QVAC {name}"
        print(f"\n{label} Results:")
        print(f"  Total images: {len(images)}")
        print(f"  Total regions detected: {total_regions}")
        print(f"  Total OCR time: {total_time:.2f}s")
        print(f"  Avg time per image: {total_time/len(images):.2f}s")
        print(f"  Init time: {init_time:.2f}s")

        if result.returncode != 0:
            print(f"  Warning: QVAC returned code {result.returncode}")
            print(f"  Stderr: {result.stderr[-500:]}")

        return {
            'backend': label,
            'images': len(images),
            'regions': total_regions,
            'total_time': total_time,
            'init_time': init_time,
            'avg_time': total_time / len(images),
            'times': times
        }
    finally:
        os.unlink(input_file)
        if os.path.exists(output_file):
            os.unlink(output_file)


def print_comparison(results_list):
    """Print a comparison table of all backends."""
    print(f"\n{'='*70}")
    print("BENCHMARK SUMMARY")
    print(f"{'='*70}")
    print(f"Images tested: {results_list[0]['images']}")
    print()
    print(f"{'Backend':<25} {'Total Time':<15} {'Avg/Image':<15} {'Regions':<10}")
    print("-" * 65)
    for r in results_list:
        print(f"{r['backend']:<25} {r['total_time']:.2f}s{'':<9} {r['avg_time']:.2f}s{'':<9} {r['regions']}")
    print()

    # Speedup vs first result
    baseline = results_list[0]
    for r in results_list[1:]:
        if r['total_time'] > 0 and baseline['total_time'] > 0:
            speedup = baseline['total_time'] / r['total_time']
            if speedup > 1:
                print(f"{r['backend']} is {speedup:.2f}x faster than {baseline['backend']}")
            else:
                print(f"{baseline['backend']} is {1/speedup:.2f}x faster than {r['backend']}")


@click.command()
@click.option('--image-dir', default='./test/images', help='Directory containing test images')
@click.option('--limit', default=100, type=int, help='Number of images to test')
@click.option('--pipeline', default='both', type=click.Choice(['easyocr', 'doctr', 'both']),
              help='GGML pipeline(s) to benchmark')
@click.option('--detector', default=None, help='EasyOCR detector GGUF path')
@click.option('--recognizer', default=None, help='EasyOCR recognizer GGUF path')
@click.option('--doctr-detector', default=None, help='DocTR detector GGUF path')
@click.option('--doctr-recognizer', default=None, help='DocTR recognizer GGUF path')
@click.option('--dataset-path', default=None, help='Use OCRBench_v2 images instead of image-dir')
def main(image_dir, limit, pipeline, detector, recognizer, doctr_detector,
         doctr_recognizer, dataset_path):
    """Quick benchmark comparing GGML pipelines against Python references."""
    # Find images
    if dataset_path:
        img_search_dir = os.path.join(dataset_path, 'images')
        if not os.path.exists(img_search_dir):
            img_search_dir = dataset_path
    else:
        img_search_dir = image_dir

    print(f"Finding images in {img_search_dir}...")
    images = find_images(img_search_dir, limit)
    print(f"Found {len(images)} images")

    if len(images) < 10:
        print("Error: Not enough images found (need at least 10)")
        sys.exit(1)

    results_list = []
    run_easyocr = pipeline in ('easyocr', 'both')
    run_doctr = pipeline in ('doctr', 'both')

    # EasyOCR pipeline
    if run_easyocr:
        if not detector or not recognizer:
            print("Error: --detector and --recognizer required for easyocr pipeline")
            sys.exit(1)

        # Python reference
        try:
            import easyocr
            def init_easyocr():
                return easyocr.Reader(['en'], gpu=False, verbose=False)
            def infer_easyocr(reader, img):
                return reader.readtext(img)
            r = run_reference_benchmark(images, 'EasyOCR', init_easyocr, infer_easyocr)
            results_list.append(r)
        except ImportError:
            print("EasyOCR not installed, skipping reference benchmark")

        # GGML
        r = run_ggml_benchmark(images, 'easyocr', detector, recognizer, 'easyocr')
        results_list.append(r)

    # DocTR pipeline
    if run_doctr:
        if not doctr_detector or not doctr_recognizer:
            print("Error: --doctr-detector and --doctr-recognizer required for doctr pipeline")
            sys.exit(1)

        # Python reference
        try:
            from doctr.models import ocr_predictor
            from doctr.io import DocumentFile
            def init_doctr():
                return ocr_predictor(det_arch='db_resnet50', reco_arch='crnn_vgg16_bn', pretrained=True)
            def infer_doctr(predictor, img):
                doc = DocumentFile.from_images(img)
                result = predictor(doc)
                words = []
                for page in result.pages:
                    for block in page.blocks:
                        for line in block.lines:
                            words.extend(line.words)
                return words
            r = run_reference_benchmark(images, 'DocTR', init_doctr, infer_doctr)
            results_list.append(r)
        except ImportError:
            print("python-doctr not installed, skipping reference benchmark")

        # GGML
        r = run_ggml_benchmark(images, 'doctr', doctr_detector, doctr_recognizer, 'doctr')
        results_list.append(r)

    if results_list:
        print_comparison(results_list)


if __name__ == '__main__':
    main()
