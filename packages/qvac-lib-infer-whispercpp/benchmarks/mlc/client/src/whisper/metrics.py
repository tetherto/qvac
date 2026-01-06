from typing import List
from evaluate import load


def calculate_cer(
    predictions: List[str],
    references: List[str],
) -> float:
    """
    Calculate CER score for a set of predictions against references.
    """

    cer_metric = load("cer")
    return cer_metric.compute(predictions=predictions, references=references) * 100


def calculate_wer(
    predictions: List[str],
    references: List[str],
) -> float:
    """
    Calculate WER score for a set of hypotheses against references.
    """
    wer_metric = load("wer")
    return wer_metric.compute(predictions=predictions, references=references) * 100
