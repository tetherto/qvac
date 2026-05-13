"""Dataset loading for TTS benchmarks"""

import json
import logging
from pathlib import Path
from typing import List, Dict

from datasets import load_dataset
from .config import DatasetConfig

logger = logging.getLogger(__name__)

# Harvard Sentences - Phonetically Balanced Sentences for Speech Testing
# IEEE Recommended Practice for Speech Quality Measurements

# Path to dataset JSON files
DATASET_DIR = Path(__file__).parent / "dataset"

# Language code mapping to JSON files
SUPPORTED_LANGUAGES = {
    "en": "en.json",
    "es": "es.json",
}


def load_harvard_sentences_from_json(language: str) -> List[str]:
    """
    Load Harvard sentences from JSON file for the specified language.
    
    Args:
        language: Language code (e.g., 'en-us')
        
    Returns:
        List of Harvard sentences
        
    Raises:
        FileNotFoundError: If the JSON file for the language doesn't exist
        KeyError: If the JSON file doesn't have the expected structure
    """
    language = language.lower()
    
    # Get the JSON filename for this language
    if language not in SUPPORTED_LANGUAGES:
        # Try to extract base language code (e.g., 'en' from 'en-us')
        base_language = language.split('-')[0]
        if base_language in SUPPORTED_LANGUAGES:
            json_file = SUPPORTED_LANGUAGES[base_language]
        else:
            raise ValueError(f"Language '{language}' not supported. Supported languages: {', '.join(sorted(set(SUPPORTED_LANGUAGES.values())))}")
    else:
        json_file = SUPPORTED_LANGUAGES[language]
    
    # Load the JSON file
    json_path = DATASET_DIR / json_file
    if not json_path.exists():
        raise FileNotFoundError(f"Dataset file not found: {json_path}")
    
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    if "harvard_sentences" not in data:
        raise KeyError(f"JSON file {json_file} is missing 'harvard_sentences' key")
    
    return data["harvard_sentences"]


def load_harvard_sentences(cfg: DatasetConfig, language: str = "en-us") -> List[str]:
    """
    Load Harvard Sentences for benchmarking in the specified language.
    These are 72 phonetically balanced sentences designed for speech testing.
    
    Args:
        cfg: Dataset configuration
        language: Language code (e.g., 'en-us')
        
    Returns:
        List of text strings to synthesize
    """
    try:
        texts = load_harvard_sentences_from_json(language)
        logger.info(f"Loading Harvard Sentences (phonetically balanced) for language: {language}")
        logger.info(f"Loaded {len(texts)} Harvard sentences")
    except (ValueError, FileNotFoundError) as e:
        # Fallback to English if language not found
        logger.warning(f"{e}. Falling back to English.")
        texts = load_harvard_sentences_from_json("en-us")
        logger.info(f"Loaded {len(texts)} Harvard sentences (English fallback)")
    
    # Limit samples if configured
    if cfg.max_samples > 0 and cfg.max_samples < len(texts):
        texts = texts[:cfg.max_samples]
        logger.info(f"Limited to {len(texts)} samples based on max_samples config")
    
    return texts


def load_ag_news(cfg: DatasetConfig) -> List[str]:
    """
    Load text samples from AG News dataset
    
    Args:
        cfg: Dataset configuration
        
    Returns:
        List of text strings to synthesize
    """
    logger.info(f"Loading benchmark texts from AG News dataset")
    
    # Load AG News test split (7,600 news articles)
    ds = load_dataset("ag_news", split="test")
    benchmark_texts = ds["text"]
    
    logger.info(f"Loaded {len(benchmark_texts)} benchmark texts")
    
    # Limit samples if configured
    if cfg.max_samples > 0 and cfg.max_samples < len(benchmark_texts):
        texts = benchmark_texts[:cfg.max_samples]
        logger.info(f"Limited to {len(texts)} samples based on max_samples config")
        return texts
    
    return benchmark_texts


def load_librispeech(cfg: DatasetConfig) -> List[str]:
    """
    Load text samples from LibriSpeech test-clean
    
    Args:
        cfg: Dataset configuration
        
    Returns:
        List of text strings to synthesize
    """
    logger.info(f"Loading benchmark texts from LibriSpeech test-clean")
    
    # Load LibriSpeech test-clean split
    ds = load_dataset("librispeech_asr", split="test.clean")
    benchmark_texts = ds["text"]
    
    logger.info(f"Loaded {len(benchmark_texts)} benchmark texts")
    
    # Limit samples if configured
    if cfg.max_samples > 0 and cfg.max_samples < len(benchmark_texts):
        texts = benchmark_texts[:cfg.max_samples]
        logger.info(f"Limited to {len(texts)} samples based on max_samples config")
        return texts
    
    return benchmark_texts


def load_dataset_texts(cfg: DatasetConfig, language: str = "en-us") -> List[str]:
    """
    Load dataset texts based on configuration
    
    Args:
        cfg: Dataset configuration
        language: Language code for Harvard sentences (e.g., 'en-us')
        
    Returns:
        List of text strings
    """
    dataset_name = cfg.name.lower()
    
    # For Harvard sentences, pass language parameter
    if dataset_name == "harvard":
        return load_harvard_sentences(cfg, language)
    
    # For other datasets, use the original loaders (no language support yet)
    dataset_loaders = {
        "ag_news": load_ag_news,
        "librispeech": load_librispeech,
    }
    
    if dataset_name not in dataset_loaders:
        logger.warning(f"Unknown dataset '{cfg.name}', falling back to Harvard sentences")
        return load_harvard_sentences(cfg, language)
    
    return dataset_loaders[dataset_name](cfg)


if __name__ == "__main__":
    # Test dataset loading
    from .config import Config
    
    cfg = Config.from_yaml()
    texts = load_dataset_texts(cfg.dataset)
    
    print(f"Loaded {len(texts)} texts")
    print("\nFirst 3 texts:")
    for i, text in enumerate(texts[:3], 1):
        print(f"{i}. {text}")
