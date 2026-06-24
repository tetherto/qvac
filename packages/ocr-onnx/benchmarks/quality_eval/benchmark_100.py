#!/usr/bin/env python3
"""
Benchmark script to compare EasyOCR vs QVAC OCR on 100 images.
"""

import os
import sys
import time
import json
import subprocess
import tempfile
from pathlib import Path

# Configuration
NUM_IMAGES = 100
IMAGE_DIR = os.environ.get('BENCHMARK_IMAGE_DIR', './test/images')
QVAC_DIR = Path(__file__).parent.parent.parent

def find_images(directory, limit=100):
    """Find image files in directory."""
    images = []
    for ext in ['*.jpg', '*.jpeg', '*.png']:
        import glob
        images.extend(glob.glob(os.path.join(directory, '**', ext), recursive=True))
        if len(images) >= limit:
            break
    return images[:limit]

def run_easyocr_benchmark(images):
    """Run EasyOCR on all images."""
    print(f"\n{'='*60}")
    print("Running EasyOCR benchmark...")
    print(f"{'='*60}")

    import easyocr

    # Initialize reader
    start_init = time.time()
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    init_time = time.time() - start_init
    print(f"EasyOCR initialization: {init_time:.2f}s")

    # Run OCR on all images
    times = []
    total_regions = 0

    start_total = time.time()
    for i, img_path in enumerate(images):
        start = time.time()
        try:
            results = reader.readtext(img_path)
            total_regions += len(results)
        except Exception as e:
            print(f"  Error on {img_path}: {e}")
            results = []
        elapsed = time.time() - start
        times.append(elapsed)

        if (i + 1) % 10 == 0:
            print(f"  Progress: {i+1}/{len(images)} images, last: {elapsed:.2f}s")

    total_time = time.time() - start_total

    print(f"\nEasyOCR Results:")
    print(f"  Total images: {len(images)}")
    print(f"  Total regions detected: {total_regions}")
    print(f"  Total OCR time: {total_time:.2f}s")
    print(f"  Avg time per image: {total_time/len(images):.2f}s")
    print(f"  Init time: {init_time:.2f}s")

    return {
        'backend': 'easyocr',
        'images': len(images),
        'regions': total_regions,
        'total_time': total_time,
        'init_time': init_time,
        'avg_time': total_time / len(images),
        'times': times
    }

def run_qvac_benchmark(images):
    """Run QVAC OCR on all images."""
    print(f"\n{'='*60}")
    print("Running QVAC OCR benchmark...")
    print(f"{'='*60}")

    # Create temp file with image paths
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        for img in images:
            f.write(img + '\n')
        input_file = f.name

    output_fd = tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False)
    output_file = output_fd.name
    output_fd.close()

    try:
        # Run QVAC batch CLI
        start_total = time.time()
        result = subprocess.run(
            ['bare', 'benchmarks/quality_eval/ocr_batch_cli.js',
             '--input', input_file, '--output', output_file],
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
                    except:
                        pass

        print(f"\nQVAC Results:")
        print(f"  Total images: {len(images)}")
        print(f"  Total regions detected: {total_regions}")
        print(f"  Total OCR time: {total_time:.2f}s")
        print(f"  Avg time per image: {total_time/len(images):.2f}s")
        print(f"  Init time: {init_time:.2f}s")

        if result.returncode != 0:
            print(f"  Warning: QVAC returned code {result.returncode}")
            print(f"  Stderr: {result.stderr[-500:]}")

        return {
            'backend': 'qvac',
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

def main():
    print("Finding images...")
    images = find_images(IMAGE_DIR, NUM_IMAGES)
    print(f"Found {len(images)} images")

    if len(images) < 10:
        print("Error: Not enough images found")
        sys.exit(1)

    # Run benchmarks
    easyocr_results = run_easyocr_benchmark(images)
    qvac_results = run_qvac_benchmark(images)

    # Summary
    print(f"\n{'='*60}")
    print("BENCHMARK SUMMARY")
    print(f"{'='*60}")
    print(f"Images tested: {len(images)}")
    print()
    print(f"{'Backend':<15} {'Total Time':<15} {'Avg/Image':<15} {'Regions':<10}")
    print("-" * 55)
    print(f"{'EasyOCR':<15} {easyocr_results['total_time']:.2f}s{'':<9} {easyocr_results['avg_time']:.2f}s{'':<9} {easyocr_results['regions']}")
    print(f"{'QVAC':<15} {qvac_results['total_time']:.2f}s{'':<9} {qvac_results['avg_time']:.2f}s{'':<9} {qvac_results['regions']}")
    print()

    speedup = easyocr_results['total_time'] / qvac_results['total_time'] if qvac_results['total_time'] > 0 else 0
    if speedup > 1:
        print(f"QVAC is {speedup:.2f}x faster than EasyOCR")
    else:
        print(f"EasyOCR is {1/speedup:.2f}x faster than QVAC")

if __name__ == '__main__':
    main()
