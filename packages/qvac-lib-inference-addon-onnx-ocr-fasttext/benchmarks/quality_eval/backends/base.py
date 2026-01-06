"""Base class for OCR backends."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional


@dataclass
class BoundingBox:
    """Bounding box for detected text region."""
    points: List[List[float]]  # [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
    text: str
    confidence: float


@dataclass
class OCRResult:
    """Result from OCR inference."""
    text: str  # Combined text output
    boxes: List[BoundingBox] = field(default_factory=list)
    confidence: float = 0.0  # Average confidence
    inference_time: float = 0.0  # Time in seconds
    raw_output: Any = None  # Original backend output


class OCRBackend(ABC):
    """Abstract base class for OCR backends.

    All OCR backends should inherit from this class and implement
    the required methods.
    """

    def __init__(self, name: Optional[str] = None, **kwargs):
        """Initialize the backend.

        Args:
            name: Optional custom name for the backend
            **kwargs: Additional backend-specific arguments
        """
        self.name = name or self.__class__.__name__
        self._initialized = False

    @abstractmethod
    def initialize(self) -> None:
        """Initialize the backend (load models, etc.).

        This should be called before running OCR.
        """
        pass

    @abstractmethod
    def run_ocr(self, image_path: str) -> OCRResult:
        """Run OCR on an image.

        Args:
            image_path: Path to the image file

        Returns:
            OCRResult with extracted text and metadata
        """
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """Clean up resources (unload models, etc.)."""
        pass

    @property
    def is_initialized(self) -> bool:
        """Check if the backend is initialized."""
        return self._initialized

    def __enter__(self):
        """Context manager entry."""
        self.initialize()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.cleanup()
        return False

    @staticmethod
    def combine_box_texts(boxes: List[BoundingBox], separator: str = " ") -> str:
        """Combine text from multiple bounding boxes.

        Args:
            boxes: List of BoundingBox objects
            separator: String to join texts with

        Returns:
            Combined text string
        """
        return separator.join(box.text for box in boxes if box.text)

    @staticmethod
    def calculate_average_confidence(boxes: List[BoundingBox]) -> float:
        """Calculate average confidence across bounding boxes.

        Args:
            boxes: List of BoundingBox objects

        Returns:
            Average confidence (0.0 if no boxes)
        """
        if not boxes:
            return 0.0
        return sum(box.confidence for box in boxes) / len(boxes)
