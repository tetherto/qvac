"""Word Error Rate (WER) metric for OCR evaluation."""

from typing import List


def levenshtein_distance_words(words1: List[str], words2: List[str]) -> int:
    """Compute Levenshtein distance at word level.

    Args:
        words1: First list of words
        words2: Second list of words

    Returns:
        Integer word-level edit distance
    """
    if len(words1) > len(words2):
        words1, words2 = words2, words1

    distances = list(range(len(words1) + 1))
    for i2, w2 in enumerate(words2):
        distances_ = [i2 + 1]
        for i1, w1 in enumerate(words1):
            if w1 == w2:
                distances_.append(distances[i1])
            else:
                distances_.append(1 + min(distances[i1], distances[i1 + 1], distances_[-1]))
        distances = distances_
    return distances[-1]


def compute_wer(prediction: str, reference: str, normalize: bool = True) -> float:
    """Compute Word Error Rate (WER).

    WER = word_edit_distance(prediction, reference) / word_count(reference)

    Args:
        prediction: OCR output text
        reference: Ground truth text
        normalize: If True, normalize texts before comparison

    Returns:
        WER value (0.0 = perfect match, higher = more errors)
    """
    if not isinstance(prediction, str):
        prediction = str(prediction) if prediction is not None else ""
    if not isinstance(reference, str):
        reference = str(reference) if reference is not None else ""

    if normalize:
        prediction = prediction.lower().strip().replace("\n", " ")
        reference = reference.lower().strip().replace("\n", " ")

    pred_words = prediction.split()
    ref_words = reference.split()

    if len(ref_words) == 0:
        return 1.0 if len(pred_words) > 0 else 0.0

    distance = levenshtein_distance_words(pred_words, ref_words)
    return distance / len(ref_words)
