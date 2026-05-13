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
