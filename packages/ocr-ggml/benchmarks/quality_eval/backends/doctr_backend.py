"""python-doctr reference backend for OCR benchmarking.

Used as the baseline when comparing against the DocTR GGML pipeline.
"""

import time
from typing import List, Optional

from .base import OCRBackend, OCRResult, BoundingBox


class DocTRBackend(OCRBackend):
    """OCR backend using the python-doctr library.

    Runs db_resnet50 + crnn_vgg16_bn (standard doctr English pipeline).
    https://github.com/mindee/doctr
    """

    def __init__(
        self,
        gpu: bool = False,
        **kwargs
    ):
        """Initialize DocTR backend.

        Args:
            gpu: Whether to use GPU acceleration
            **kwargs: Additional arguments passed to parent
        """
        super().__init__(name="doctr", **kwargs)
        self.gpu = gpu
        self.predictor = None

    def initialize(self) -> None:
        """Initialize the DocTR predictor."""
        try:
            from doctr.models import ocr_predictor
        except ImportError:
            raise ImportError(
                "python-doctr not installed. Install with: pip install 'python-doctr[torch]'"
            )

        det_arch = 'db_mobilenet_v3_large'
        reco_arch = 'crnn_mobilenet_v3_small'

        self.predictor = ocr_predictor(
            det_arch=det_arch,
            reco_arch=reco_arch,
            pretrained=True
        )
        self._initialized = True

    def run_ocr(self, image_path: str) -> OCRResult:
        """Run OCR on an image using python-doctr.

        Args:
            image_path: Path to the image file

        Returns:
            OCRResult with extracted text and bounding boxes
        """
        if not self._initialized or self.predictor is None:
            raise RuntimeError("Backend not initialized. Call initialize() first.")

        try:
            from doctr.io import DocumentFile
        except ImportError:
            raise ImportError(
                "python-doctr not installed. Install with: pip install 'python-doctr[torch]'"
            )

        start_time = time.perf_counter()

        doc = DocumentFile.from_images(image_path)
        result = self.predictor(doc)

        elapsed = time.perf_counter() - start_time

        boxes = []
        for page in result.pages:
            img_h, img_w = page.dimensions
            for block in page.blocks:
                for line in block.lines:
                    for word in line.words:
                        # word.geometry is ((x1, y1), (x2, y2)) in relative [0,1] coords
                        (x1_rel, y1_rel), (x2_rel, y2_rel) = word.geometry
                        x1 = x1_rel * img_w
                        y1 = y1_rel * img_h
                        x2 = x2_rel * img_w
                        y2 = y2_rel * img_h
                        # Convert to 4-point polygon matching the shared format
                        points = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
                        boxes.append(BoundingBox(
                            points=points,
                            text=word.value,
                            confidence=float(word.confidence)
                        ))

        combined_text = self.combine_box_texts(boxes, separator=" ")
        avg_confidence = self.calculate_average_confidence(boxes)

        return OCRResult(
            text=combined_text,
            boxes=boxes,
            confidence=avg_confidence,
            inference_time=elapsed,
            raw_output=result
        )

    def cleanup(self) -> None:
        """Clean up DocTR resources."""
        self.predictor = None
        self._initialized = False
