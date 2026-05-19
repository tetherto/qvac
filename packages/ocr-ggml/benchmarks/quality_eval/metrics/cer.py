"""Character Error Rate (CER) metric for OCR evaluation."""

from typing import Union


def levenshtein_distance(s1: str, s2: str) -> int:
    """Compute Levenshtein (edit) distance between two strings.

    Args:
        s1: First string
        s2: Second string

    Returns:
        Integer edit distance
    """
    if len(s1) > len(s2):
        s1, s2 = s2, s1

    distances = list(range(len(s1) + 1))
    for i2, c2 in enumerate(s2):
        distances_ = [i2 + 1]
        for i1, c1 in enumerate(s1):
            if c1 == c2:
                distances_.append(distances[i1])
            else:
                distances_.append(1 + min(distances[i1], distances[i1 + 1], distances_[-1]))
        distances = distances_
    return distances[-1]


def compute_cer(prediction: str, reference: str, normalize: bool = True) -> float:
    """Compute Character Error Rate (CER).

    CER = edit_distance(prediction, reference) / len(reference)

    Args:
        prediction: OCR output text
        reference: Ground truth text
        normalize: If True, normalize texts before comparison

    Returns:
        CER value (0.0 = perfect match, higher = more errors)
    """
    if not isinstance(prediction, str):
        prediction = str(prediction) if prediction is not None else ""
    if not isinstance(reference, str):
        reference = str(reference) if reference is not None else ""

    if normalize:
        prediction = prediction.lower().strip().replace("\n", " ")
        reference = reference.lower().strip().replace("\n", " ")

    if len(reference) == 0:
        return 1.0 if len(prediction) > 0 else 0.0

    distance = levenshtein_distance(prediction, reference)
    return distance / len(reference)
