import os
import tempfile
from typing import List, Tuple
import datasets
from datasets import load_dataset, concatenate_datasets
from src.whisper.config import DatasetConfig, Config, SpeakerGroup, Language, DatasetType
import numpy as np
from transformers import WhisperProcessor
from src.whisper.dataset.common_voice_loader import load_common_voice_samples

LANGUAGE_TO_DATASET_NAME = {
    Language.ENGLISH: "english",
    Language.FRENCH: "french",
    Language.GERMAN: "german",
    Language.SPANISH: "spanish",
    Language.ITALIAN: "italian",
    Language.PORTUGUESE: "portuguese",
}

LANGUAGE_TO_WHISPER_CODE = {
    Language.ENGLISH: "en",
    Language.FRENCH: "fr",
    Language.GERMAN: "de",
    Language.SPANISH: "es",
    Language.ITALIAN: "it",
    Language.PORTUGUESE: "pt",
    Language.MANDARIN_CHINESE: "zh",
    Language.ARABIC: "ar",
    Language.RUSSIAN: "ru",
    Language.JAPANESE: "ja",
    Language.CZECH: "cs",
}

LANGUAGE_TO_FLEURS_CODE = {
    Language.ENGLISH: "en_us",
    Language.FRENCH: "fr_fr",
    Language.GERMAN: "de_de",
    Language.SPANISH: "es_419",
    Language.ITALIAN: "it_it",
    Language.PORTUGUESE: "pt_br",
    Language.MANDARIN_CHINESE: "cmn_hans_cn",
    Language.ARABIC: "ar_eg",
    Language.RUSSIAN: "ru_ru",
    Language.JAPANESE: "ja_jp",
    Language.CZECH: "cs_cz",
}


def write_raw_file(array, clip_id: str, output_dir: str) -> dict:
    """
    Write a float64/array audio to a 32-bit LE .raw file

    Args:
        array:    NumPy array of audio samples
        clip_id:  unique identifier for naming
        output_dir: directory in which to write

    Returns:
        {'id': clip_id, 'path': '/full/path/to/clip_id.raw'}
    """
    out_path = os.path.join(output_dir, f"{clip_id}.raw")
    array.astype(np.float32).tofile(out_path)
    return out_path


def get_text_from_item(item: dict) -> str:
    """Extract text from dataset item, handling different field names."""
    text = item.get("text", item.get("transcript", ""))
    if not text:
        raise ValueError(f"No text or transcript field found in dataset item: {list(item.keys())}")
    return text


def get_id_from_item(item: dict, language: Language, index: int) -> str:
    """Extract ID from dataset item, generating one if not present."""
    return item.get("id", f"{language.value}_{index}")


def load_librispeech_dataset(
    cfg: DatasetConfig, processor: WhisperProcessor
) -> Tuple[List[str], List[str]]:
    """
    Loads the Librispeech or Multilingual Librispeech test split and writes the audio to a .raw file in a temporary directory.

    Args:
        cfg: DatasetConfig containing:
            - speaker_group: Subset of LibriSpeech speakers based on transcript WER (all, clean, other)
            - language: Language for the dataset (english uses LibriSpeech, others use Multilingual LibriSpeech)

    Returns:
        sources: List[str] of paths to .raw files for each audio record
        references: List[str] of reference text transcriptions
    """
    
    if cfg.language == Language.ENGLISH:
        ds = load_dataset(
            "src/whisper/dataset/librispeech_dataset_builder.py",
            name=cfg.speaker_group.value,
            trust_remote_code=True,
        )

        if cfg.speaker_group == SpeakerGroup.ALL:
            combined_ds = concatenate_datasets([ds["test.clean"], ds["test.other"]])
        else:
            combined_ds = ds["test"]
    else:
        lang_name = LANGUAGE_TO_DATASET_NAME[cfg.language]
        print(f"Loading {lang_name} test set from facebook/multilingual_librispeech...")
        streaming_ds = load_dataset(
            "facebook/multilingual_librispeech",
            lang_name,
            split="test",
            streaming=True
        )
        
        tmp_dir = tempfile.mkdtemp(prefix=f"librispeech_{cfg.language.value}_raw_")
        sources: List[str] = []
        references: List[str] = []
        
        print(f"Processing streaming dataset...")
        for i, item in enumerate(streaming_ds):
            if cfg.max_samples > 0 and i >= cfg.max_samples:
                break
            
            if i % 100 == 0:
                print(f"  Processed {i} samples...")
            
            text = get_text_from_item(item)
            item_id = get_id_from_item(item, cfg.language, i)
            
            sources.append(write_raw_file(item["audio"]["array"], item_id, tmp_dir))
            references.append(processor.tokenizer.normalize(text))
        
        print(f"Loaded {len(sources)} audio samples")
        return sources, references
    
    tmp_dir = tempfile.mkdtemp(prefix=f"librispeech_{cfg.language.value}_raw_")
    sources: List[str] = []
    references: List[str] = []
    
    max_items = len(combined_ds) if cfg.max_samples <= 0 else min(cfg.max_samples, len(combined_ds))
    
    for i in range(max_items):
        item = combined_ds[i]
        text = get_text_from_item(item)
        item_id = get_id_from_item(item, cfg.language, i)
        sources.append(write_raw_file(item["audio"]["array"], item_id, tmp_dir))
        references.append(processor.tokenizer.normalize(text))
    return sources, references


def load_fleurs_dataset(
    cfg: DatasetConfig, processor: WhisperProcessor
) -> Tuple[List[str], List[str]]:
    
    if cfg.language not in LANGUAGE_TO_FLEURS_CODE:
        raise ValueError(f"Language {cfg.language} not supported for FLEURS dataset")
    
    fleurs_lang_code = LANGUAGE_TO_FLEURS_CODE[cfg.language]
    print(f"Loading FLEURS test set for {cfg.language.value} ({fleurs_lang_code})...")
    
    streaming_ds = load_dataset(
        "google/fleurs",
        fleurs_lang_code,
        split="test",
        streaming=True,
        trust_remote_code=True,
    )
    
    tmp_dir = tempfile.mkdtemp(prefix=f"fleurs_{cfg.language.value}_raw_")
    sources: List[str] = []
    references: List[str] = []
    
    print(f"Processing FLEURS dataset (streaming mode)...")
    for i, item in enumerate(streaming_ds):
        if cfg.max_samples > 0 and i >= cfg.max_samples:
            break
        
        if i % 100 == 0:
            print(f"  Processed {i} samples...")
        
        text = item.get("transcription", item.get("raw_transcription", ""))
        if not text:
            raise ValueError(f"No transcription field found in FLEURS item: {list(item.keys())}")
        
        item_id = item.get("id", f"fleurs_{cfg.language.value}_{i}")
        
        audio_array = item["audio"]["array"]
        
        sources.append(write_raw_file(audio_array, str(item_id), tmp_dir))
        references.append(processor.tokenizer.normalize(text))
    
    print(f"Loaded {len(sources)} audio samples from FLEURS")
    return sources, references


def load_common_voice_dataset(
    cfg: DatasetConfig, processor: WhisperProcessor
) -> Tuple[List[str], List[str]]:
    """
    Load Common Voice dataset from a manifest file.
    
    Args:
        cfg: DatasetConfig with common_voice_manifest path
        processor: WhisperProcessor for text normalization
    
    Returns:
        sources: List[str] of paths to .raw files
        references: List[str] of reference transcriptions
    """
    if not cfg.common_voice_manifest:
        raise ValueError(
            "common_voice_manifest path is required for COMMON_VOICE dataset type. "
            "Please specify the path to manifest.json in your config file."
        )
    
    if not os.path.exists(cfg.common_voice_manifest):
        raise FileNotFoundError(
            f"Common Voice manifest file not found: {cfg.common_voice_manifest}"
        )
    
    print(f"Loading Common Voice dataset from: {cfg.common_voice_manifest}")
    
    return load_common_voice_samples(
        manifest_path=cfg.common_voice_manifest,
        processor=processor,
        max_samples=cfg.max_samples
    )


def load_dataset_by_type(
    cfg: DatasetConfig, processor: WhisperProcessor
) -> Tuple[List[str], List[str]]:
    
    if cfg.dataset_type == DatasetType.LIBRISPEECH:
        return load_librispeech_dataset(cfg, processor)
    elif cfg.dataset_type == DatasetType.FLEURS:
        return load_fleurs_dataset(cfg, processor)
    elif cfg.dataset_type == DatasetType.COMMON_VOICE:
        return load_common_voice_dataset(cfg, processor)
    else:
        raise ValueError(f"Unknown dataset type: {cfg.dataset_type}")


if __name__ == "__main__":
    cfg = Config.from_yaml()
    srcs, refs = load_dataset_by_type(cfg.dataset, None)
    print(
        f"Loaded {len(srcs)} audio data and corresponding transcriptions."
    )
    print("Example audio data:", srcs[0])
    print("Example transcription:", refs[0])
