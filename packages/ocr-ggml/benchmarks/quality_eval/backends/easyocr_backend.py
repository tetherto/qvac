"""EasyOCR backend for OCR benchmarking."""

import time
from typing import List, Optional

from .base import OCRBackend, OCRResult, BoundingBox


class EasyOCRBackend(OCRBackend):
    """OCR backend using the EasyOCR library.

    EasyOCR is a ready-to-use OCR with 80+ supported languages.
    https://github.com/JaidedAI/EasyOCR
    """

    def __init__(
        self,
        languages: Optional[List[str]] = None,
        gpu: bool = False,
        **kwargs
    ):
        """Initialize EasyOCR backend.

        Args:
            languages: List of language codes (e.g., ['en']). Default: ['en']
            gpu: Whether to use GPU acceleration
            **kwargs: Additional arguments passed to parent
        """
        super().__init__(name="easyocr", **kwargs)
        self.languages = languages or ['en']
        self.gpu = gpu
        self.reader = None

    def initialize(self) -> None:
        """Initialize the EasyOCR reader."""
        try:
            import easyocr
        except ImportError:
            raise ImportError(
                "EasyOCR not installed. Install with: pip install easyocr"
            )

        self.reader = easyocr.Reader(
            self.languages,
            gpu=self.gpu,
            verbose=False
        )
        self._initialized = True

    def run_ocr(self, image_path: str) -> OCRResult:
        """Run OCR on an image using EasyOCR.

        Args:
            image_path: Path to the image file

        Returns:
            OCRResult with extracted text and bounding boxes
        """
        if not self._initialized or self.reader is None:
            raise RuntimeError("Backend not initialized. Call initialize() first.")

        start_time = time.perf_counter()

        # Run EasyOCR
        # Returns: [([x1,y1], [x2,y2], [x3,y3], [x4,y4]), text, confidence]
        results = self.reader.readtext(image_path)

        elapsed = time.perf_counter() - start_time

        # Convert to BoundingBox objects
        boxes = []
        for result in results:
            bbox_points, text, confidence = result
            boxes.append(BoundingBox(
                points=bbox_points,
                text=text,
                confidence=confidence
            ))

        # Combine text from all boxes
        combined_text = self.combine_box_texts(boxes, separator=" ")
        avg_confidence = self.calculate_average_confidence(boxes)

        return OCRResult(
            text=combined_text,
            boxes=boxes,
            confidence=avg_confidence,
            inference_time=elapsed,
            raw_output=results
        )

    def cleanup(self) -> None:
        """Clean up EasyOCR resources."""
        self.reader = None
        self._initialized = False
