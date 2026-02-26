"""Text normalization utilities for OCR comparison."""

import re
from typing import Tuple


def normalize_text(text: str, lowercase: bool = True, collapse_whitespace: bool = True) -> str:
    """Normalize text for comparison.

    Args:
        text: Input text string
        lowercase: Convert to lowercase
        collapse_whitespace: Replace multiple whitespace with single space

    Returns:
        Normalized text string
    """
    if not isinstance(text, str):
        text = str(text)

    text = text.strip()
    text = text.replace("\n", " ")

    if collapse_whitespace:
        text = re.sub(r'\s+', ' ', text)

    if lowercase:
        text = text.lower()

    return text


def normalize_for_comparison(prediction: str, reference: str,
                              lowercase: bool = True) -> Tuple[str, str]:
    """Normalize both prediction and reference for fair comparison.

    Args:
        prediction: OCR output text
        reference: Ground truth text
        lowercase: Convert to lowercase

    Returns:
        Tuple of (normalized_prediction, normalized_reference)
    """
    pred = normalize_text(prediction, lowercase=lowercase)
    ref = normalize_text(reference, lowercase=lowercase)
    return pred, ref
