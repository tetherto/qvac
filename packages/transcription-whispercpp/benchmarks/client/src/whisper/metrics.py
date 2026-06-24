from typing import List, Tuple, Optional
import numpy as np
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


def levenshtein_distance(s1: str, s2: str) -> int:
    """
    Calculate the Levenshtein distance between two strings.
    
    Args:
        s1: First string
        s2: Second string
        
    Returns:
        The minimum number of single-character edits (insertions, deletions,
        or substitutions) required to change s1 into s2.
    """
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    
    if len(s2) == 0:
        return len(s1)
    
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    
    return previous_row[-1]


def fuzzy_ratio(s1: str, s2: str) -> float:
    """
    Calculate the fuzzy ratio between two strings using Levenshtein distance.
    
    Formula: FR(s1, s2) = (len(s1) + len(s2) - LD) / (len(s1) + len(s2))
    
    Args:
        s1: First string
        s2: Second string
        
    Returns:
        A similarity score between 0 and 1, where 1 indicates identical strings.
    """
    if not s1 and not s2:
        return 1.0
    
    total_len = len(s1) + len(s2)
    if total_len == 0:
        return 1.0
    
    ld = levenshtein_distance(s1, s2)
    return (total_len - ld) / total_len


def cosine_similarity(v1: np.ndarray, v2: np.ndarray) -> float:
    """
    Calculate the cosine similarity between two vectors.
    
    Args:
        v1: First vector
        v2: Second vector
        
    Returns:
        Cosine similarity between -1 and 1.
    """
    norm1 = np.linalg.norm(v1)
    norm2 = np.linalg.norm(v2)
    
    if norm1 == 0 or norm2 == 0:
        return 0.0
    
    return float(np.dot(v1, v2) / (norm1 * norm2))


def calculate_syntactic_score(
    reference: str,
    hypothesis: str,
    tokenizer=None,
) -> float:
    """
    Calculate the syntactic score between reference and hypothesis transcripts.
    
    Uses fuzzy matching on word tokens to measure morphological and grammatical
    alignment. In a full implementation, this would use CAMeLBERT-Mix for
    Arabic-specific morpho-syntactic tagging.
    
    Args:
        reference: The reference transcript
        hypothesis: The hypothesis (predicted) transcript
        tokenizer: Optional tokenizer for language-specific processing
        
    Returns:
        A syntactic similarity score between 0 and 1.
    """
    ref_tokens = reference.strip().split()
    hyp_tokens = hypothesis.strip().split()
    
    if not ref_tokens and not hyp_tokens:
        return 1.0
    
    if not ref_tokens or not hyp_tokens:
        return 0.0
    
    # Calculate fuzzy ratio for aligned tokens
    scores = []
    min_len = min(len(ref_tokens), len(hyp_tokens))
    
    for i in range(min_len):
        score = fuzzy_ratio(ref_tokens[i], hyp_tokens[i])
        scores.append(score)
    
    # Penalize length differences
    max_len = max(len(ref_tokens), len(hyp_tokens))
    for _ in range(max_len - min_len):
        scores.append(0.0)
    
    return sum(scores) / len(scores) if scores else 0.0


def calculate_semantic_score(
    reference: str,
    hypothesis: str,
    model=None,
) -> float:
    """
    Calculate the semantic score between reference and hypothesis transcripts.
    
    Uses cosine similarity of sentence embeddings. In production, this would use
    the all-MiniLM-L6-v2 model for generating embeddings.
    
    Args:
        reference: The reference transcript
        hypothesis: The hypothesis (predicted) transcript
        model: Optional pre-loaded sentence transformer model
        
    Returns:
        A semantic similarity score between 0 and 1.
    """
    if model is not None:
        # Use provided model (e.g., SentenceTransformer)
        embeddings = model.encode([reference, hypothesis])
        return cosine_similarity(embeddings[0], embeddings[1])
    
    # Fallback: simple word overlap-based similarity
    ref_words = set(reference.lower().strip().split())
    hyp_words = set(hypothesis.lower().strip().split())
    
    if not ref_words and not hyp_words:
        return 1.0
    
    if not ref_words or not hyp_words:
        return 0.0
    
    intersection = ref_words & hyp_words
    union = ref_words | hyp_words
    
    return len(intersection) / len(union)


def calculate_aradiawer(
    predictions: List[str],
    references: List[str],
    min_score_threshold: float = 0.5,
    semantic_model=None,
    syntactic_tokenizer=None,
) -> Tuple[float, float, float, float]:
    """
    Calculate the AraDiaWER metric for Dialectical Arabic ASR evaluation.
    
    AraDiaWER is an explainable metric that refines WER by incorporating
    linguistic nuances specific to Arabic dialects. The formula is:
    
        AraDiaWER = WER / (Score_sem + Score_syn)
    
    Where higher syntactic and semantic scores reduce the effective error rate.
    
    Reference: AraDiaWER: An Explainable Metric For Dialectical Arabic ASR
    https://aclanthology.org/2023.fieldmatters-1.8.pdf
    
    Args:
        predictions: List of hypothesis (predicted) transcripts
        references: List of reference transcripts
        min_score_threshold: Minimum threshold for scores to avoid unstable weights
            (default: 0.5). Scores below this are clamped to this value.
        semantic_model: Optional pre-loaded sentence transformer model for
            semantic scoring (e.g., all-MiniLM-L6-v2)
        syntactic_tokenizer: Optional tokenizer for syntactic analysis
            (e.g., CAMeLBERT-Mix based)
            
    Returns:
        A tuple of (aradiawer, wer, avg_semantic_score, avg_syntactic_score)
        - aradiawer: The AraDiaWER score (percentage)
        - wer: The standard WER score (percentage)
        - avg_semantic_score: Average semantic similarity score [0,1]
        - avg_syntactic_score: Average syntactic similarity score [0,1]
        
    Raises:
        ValueError: If predictions and references have different lengths
    """
    if len(predictions) != len(references):
        raise ValueError(
            f"Number of predictions ({len(predictions)}) must match "
            f"number of references ({len(references)})"
        )
    
    if not predictions:
        raise ValueError("Predictions and references cannot be empty")
    
    # Calculate WER using the standard metric
    wer_metric = load("wer")
    wer = wer_metric.compute(predictions=predictions, references=references) * 100
    
    # Calculate semantic and syntactic scores for each pair
    semantic_scores = []
    syntactic_scores = []
    
    for pred, ref in zip(predictions, references):
        sem_score = calculate_semantic_score(ref, pred, model=semantic_model)
        syn_score = calculate_syntactic_score(ref, pred, tokenizer=syntactic_tokenizer)
        
        semantic_scores.append(sem_score)
        syntactic_scores.append(syn_score)
    
    # Average scores across all samples
    avg_semantic = sum(semantic_scores) / len(semantic_scores)
    avg_syntactic = sum(syntactic_scores) / len(syntactic_scores)
    
    # Apply minimum threshold to avoid unstable weights
    avg_semantic = max(avg_semantic, min_score_threshold)
    avg_syntactic = max(avg_syntactic, min_score_threshold)
    
    # Calculate AraDiaWER
    score_sum = avg_semantic + avg_syntactic
    aradiawer = wer / score_sum if score_sum > 0 else wer
    
    return aradiawer, wer, avg_semantic, avg_syntactic


def calculate_aradiawer_single(
    prediction: str,
    reference: str,
    min_score_threshold: float = 0.5,
    semantic_model=None,
    syntactic_tokenizer=None,
) -> Tuple[float, float, float, float]:
    """
    Calculate the AraDiaWER metric for a single prediction-reference pair.
    
    This is a convenience wrapper around calculate_aradiawer for single samples.
    
    Args:
        prediction: The hypothesis (predicted) transcript
        reference: The reference transcript
        min_score_threshold: Minimum threshold for scores (default: 0.5)
        semantic_model: Optional sentence transformer model
        syntactic_tokenizer: Optional tokenizer for syntactic analysis
        
    Returns:
        A tuple of (aradiawer, wer, semantic_score, syntactic_score)
    """
    return calculate_aradiawer(
        predictions=[prediction],
        references=[reference],
        min_score_threshold=min_score_threshold,
        semantic_model=semantic_model,
        syntactic_tokenizer=syntactic_tokenizer,
    )
