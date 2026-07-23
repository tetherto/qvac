"""QVAC OCR addon backend for OCR benchmarking."""

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional, List

from .base import OCRBackend, OCRResult, BoundingBox


class QVACOCRBackend(OCRBackend):
    """OCR backend using the QVAC OCR ONNX addon.

    This backend runs the QVAC OCR addon via the Bare runtime.
    Uses batch mode for better performance by keeping the model loaded.
    """

    def __init__(
        self,
        addon_path: Optional[str] = None,
        bare_path: str = "bare",
        language: str = "en",
        timeout: int = 600,
        batch_size: int = 50,
        model_dir: str = "rec_dyn",
        **kwargs
    ):
        """Initialize QVAC OCR backend.

        Args:
            addon_path: Path to the QVAC OCR addon directory
            bare_path: Path to the bare runtime executable
            language: Language code for OCR (e.g., 'en')
            timeout: Timeout in seconds for batch operations
            batch_size: Number of images to process in one batch
            model_dir: Model directory name (e.g., 'rec_dyn' or 'rec_512')
            **kwargs: Additional arguments passed to parent
        """
        super().__init__(name="qvac", **kwargs)
        self.bare_path = bare_path
        self.language = language
        self.timeout = timeout
        self.batch_size = batch_size
        self.model_dir = model_dir

        # Determine addon path
        if addon_path:
            self.addon_path = Path(addon_path)
        else:
            self.addon_path = Path(__file__).parent.parent.parent.parent

        self.cli_script = Path(__file__).parent.parent / "ocr_cli.js"
        self.batch_cli_script = Path(__file__).parent.parent / "ocr_batch_cli.js"

        # Batch state
        self._pending_images: List[str] = []
        self._results_cache: dict = {}
        self._model_load_time: Optional[int] = None

    def initialize(self) -> None:
        """Initialize the QVAC backend."""
        # Check if bare is available
        try:
            result = subprocess.run(
                [self.bare_path, "-v"],
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode != 0:
                raise RuntimeError(f"Bare runtime check failed: {result.stderr}")
        except FileNotFoundError:
            raise RuntimeError(
                f"Bare runtime not found at '{self.bare_path}'. "
                "Install with: npm install -g bare"
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("Bare runtime check timed out")

        # Check if CLI scripts exist
        if not self.cli_script.exists():
            raise RuntimeError(f"OCR CLI script not found at {self.cli_script}")

        if not self.batch_cli_script.exists():
            raise RuntimeError(f"Batch OCR CLI script not found at {self.batch_cli_script}")

        if not self.addon_path.exists():
            raise RuntimeError(f"QVAC OCR addon not found at {self.addon_path}")

        self._initialized = True

    def _run_batch(self, image_paths: List[str]) -> dict:
        """Run OCR on a batch of images.

        Returns dict mapping image_path -> result dict
        """
        if not image_paths:
            return {}

        # Create temp files for input/output
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f_in:
            input_file = f_in.name
            f_in.write('\n'.join(image_paths) + '\n')

        output_file = input_file + '.out'

        try:
            cmd = [
                self.bare_path,
                str(self.batch_cli_script),
                "--input", input_file,
                "--output", output_file,
                "--lang", self.language,
                "--model-dir", self.model_dir
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=str(self.addon_path),
                timeout=self.timeout,
                env={**os.environ, "NODE_ENV": "production"}
            )

            # Parse model load time from stderr
            for line in result.stderr.split('\n'):
                if line.startswith('MODEL_READY:'):
                    self._model_load_time = int(line.split(':')[1])
                elif line.startswith('ERROR:'):
                    raise RuntimeError(f"Batch OCR failed: {line}")

            if result.returncode != 0:
                raise RuntimeError(f"Batch OCR failed: {result.stderr}")

            # Read results
            results = {}
            with open(output_file, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line and line.startswith('{'):
                        data = json.loads(line)
                        results[data['path']] = data

            return results

        finally:
            # Cleanup temp files
            try:
                os.unlink(input_file)
            except:
                pass
            try:
                os.unlink(output_file)
            except:
                pass

    def queue_image(self, image_path: str) -> None:
        """Queue an image for batch processing."""
        self._pending_images.append(image_path)

    def flush_batch(self) -> None:
        """Process all queued images in batch."""
        if not self._pending_images:
            return

        results = self._run_batch(self._pending_images)
        self._results_cache.update(results)
        self._pending_images = []

    def run_ocr(self, image_path: str) -> OCRResult:
        """Run OCR on an image.

        For best performance, queue multiple images and flush.
        Single image calls will process immediately.
        """
        if not self._initialized:
            raise RuntimeError("Backend not initialized. Call initialize() first.")

        # Check cache first
        if image_path in self._results_cache:
            output = self._results_cache.pop(image_path)
            return self._parse_result(output)

        # Run single image batch
        results = self._run_batch([image_path])
        if image_path not in results:
            raise RuntimeError(f"No result for image: {image_path}")

        return self._parse_result(results[image_path])

    def run_ocr_batch(self, image_paths: List[str]) -> List[OCRResult]:
        """Run OCR on multiple images efficiently.

        This is the preferred method for processing many images.
        """
        if not self._initialized:
            raise RuntimeError("Backend not initialized. Call initialize() first.")

        results = self._run_batch(image_paths)

        ocr_results = []
        for path in image_paths:
            if path in results:
                ocr_results.append(self._parse_result(results[path]))
            else:
                # Return error result
                ocr_results.append(OCRResult(
                    text="",
                    boxes=[],
                    confidence=0.0,
                    inference_time=0.0,
                    raw_output={"error": "No result returned"}
                ))

        return ocr_results

    def _parse_result(self, output: dict) -> OCRResult:
        """Parse batch result dict into OCRResult."""
        if "error" in output:
            raise RuntimeError(f"QVAC OCR failed: {output['error']}")

        boxes = []
        raw_boxes = output.get("boxes", [])

        for item in raw_boxes:
            if len(item) >= 3:
                bbox_points = item[0]
                text = item[1]
                confidence = item[2]
                boxes.append(BoundingBox(
                    points=bbox_points,
                    text=text,
                    confidence=confidence
                ))

        combined_text = output.get("text", self.combine_box_texts(boxes, separator=" "))
        avg_confidence = output.get("confidence", self.calculate_average_confidence(boxes))
        inference_time = output.get("time_ms", 0) / 1000.0

        return OCRResult(
            text=combined_text,
            boxes=boxes,
            confidence=avg_confidence,
            inference_time=inference_time,
            raw_output=output
        )

    def cleanup(self) -> None:
        """Clean up QVAC backend resources."""
        self._pending_images = []
        self._results_cache = {}
        self._initialized = False

    @property
    def model_load_time(self) -> Optional[int]:
        """Return the model load time in milliseconds."""
        return self._model_load_time
