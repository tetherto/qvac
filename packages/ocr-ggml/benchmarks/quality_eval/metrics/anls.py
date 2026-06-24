"""ANLS (Average Normalized Levenshtein Similarity) metric.

This implementation follows the OCRBench_v2 vqa_metric.py logic.
"""

from typing import List, Union


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


def compute_anls(prediction: str, reference: Union[str, List[str]],
                 threshold: float = 0.5) -> float:
    """Compute ANLS (Average Normalized Levenshtein Similarity).

    This follows the OCRBench_v2 evaluation logic:
    - For short answers (< 5 words): exact substring match gives score 1.0
    - For longer answers: ANLS = 1 - (edit_distance / max_length)
    - Only scores >= threshold are returned, otherwise 0.0

    Args:
        prediction: OCR output text
        reference: Ground truth text (single string or list of valid answers)
        threshold: Minimum ANLS value to return (default 0.5)

    Returns:
        ANLS score between 0.0 and 1.0 (higher = better match)
    """
    if not isinstance(prediction, str):
        prediction = str(prediction) if prediction is not None else ""

    # Handle list of possible answers
    if isinstance(reference, list):
        best_score = 0.0
        for ref in reference:
            score = _compute_anls_single(prediction, ref, threshold)
            if score > best_score:
                best_score = score
        return best_score
    else:
        return _compute_anls_single(prediction, reference, threshold)


def _compute_anls_single(prediction: str, reference: str, threshold: float) -> float:
    """Compute ANLS for a single prediction-reference pair.

    Args:
        prediction: OCR output text
        reference: Ground truth text
        threshold: Minimum ANLS value to return

    Returns:
        ANLS score between 0.0 and 1.0
    """
    if not isinstance(reference, str):
        reference = str(reference) if reference is not None else ""

    # Normalize texts
    pred_normalized = prediction.lower().strip().replace("\n", " ")
    ref_normalized = reference.lower().strip().replace("\n", " ")

    # For short answers (< 5 words): check substring match
    if len(ref_normalized.split()) < 5:
        if ref_normalized in pred_normalized:
            return 1.0

    # For longer answers: compute ANLS
    dist = levenshtein_distance(pred_normalized, ref_normalized)
    length = max(len(pred_normalized), len(ref_normalized))

    if length == 0:
        return 1.0

    anls_value = 1.0 - (dist / length)

    # Return score only if above threshold
    return anls_value if anls_value >= threshold else 0.0


def compute_anls_strict(prediction: str, reference: str) -> float:
    """Compute strict ANLS without substring matching.

    Always computes edit distance based similarity.

    Args:
        prediction: OCR output text
        reference: Ground truth text

    Returns:
        ANLS score between 0.0 and 1.0
    """
    if not isinstance(prediction, str):
        prediction = str(prediction) if prediction is not None else ""
    if not isinstance(reference, str):
        reference = str(reference) if reference is not None else ""

    pred_normalized = prediction.lower().strip().replace("\n", " ")
    ref_normalized = reference.lower().strip().replace("\n", " ")

    dist = levenshtein_distance(pred_normalized, ref_normalized)
    length = max(len(pred_normalized), len(ref_normalized))

    if length == 0:
        return 1.0

    return 1.0 - (dist / length)
