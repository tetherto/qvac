from typing import List
from sacrebleu import corpus_bleu
from src.indictrans2.config import BleuConfig


def calculate_bleu(
    hypotheses: List[str],
    references: List[str],
    config: BleuConfig,
) -> float:
    """
    Calculate BLEU score for a set of hypotheses against references.

    Args:
        hypotheses: List of translated sentences
        references: List of reference translations
        config: BLEU configuration parameters

    Returns:
        float: BLEU score
    """
    # Convert references to the required format for sacreBLEU
    references_bleu = [(ref,) for ref in references]
    bleu = corpus_bleu(
        hypotheses,
        references_bleu,
        smooth_method=config.smooth_method,
        smooth_value=config.smooth_value,
        lowercase=config.lowercase,
        force=config.force_tokenize,
        tokenize=config.tokenizer,
        use_effective_order=config.use_effective_order,
    )
    return bleu.score
