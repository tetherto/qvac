from .base import OCRBackend, OCRResult
from .easyocr_backend import EasyOCRBackend
from .doctr_backend import DocTRBackend
from .qvac_ocr_ggml_backend import QVACOCRGgmlBackend

__all__ = ['OCRBackend', 'OCRResult', 'EasyOCRBackend', 'DocTRBackend', 'QVACOCRGgmlBackend']
