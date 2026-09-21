from statistics import mean, median
from typing import List, Optional
from evaluate import load


def summarize_first_partial_latency(latencies_ms: List[float]) -> Optional[dict]:
    """
    Summarize per-sample time-to-first-partial latencies (streaming runs only).
    """
    if not latencies_ms:
        return None
    return {"avg_ms": mean(latencies_ms), "median_ms": median(latencies_ms)}


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
    language: str = None,
) -> float:
    """
    Calculate WER score for a set of hypotheses against references.
    For Japanese/Chinese, tokenizes using fugashi/jieba before calculating WER.
    """
    if language in ["ja", "japanese"]:
        import fugashi
        tagger = fugashi.Tagger()
        
        def tokenize_japanese(text: str) -> str:
            return " ".join([word.surface for word in tagger(text)])
        
        predictions = [tokenize_japanese(p) for p in predictions]
        references = [tokenize_japanese(r) for r in references]

    elif language in ["zh", "mandarin_chinese"]:
        import jieba
        
        def tokenize_chinese(text: str) -> str:
            return " ".join(jieba.cut(text))
        
        predictions = [tokenize_chinese(p) for p in predictions]
        references = [tokenize_chinese(r) for r in references]
    
    wer_metric = load("wer")
    return wer_metric.compute(predictions=predictions, references=references) * 100
