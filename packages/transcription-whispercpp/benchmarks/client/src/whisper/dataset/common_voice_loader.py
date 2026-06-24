"""
Common Voice Dataset Loader for Benchmarking

Loads Common Voice samples that were downloaded using common_voice_downloader.py
and formats them for the benchmarking pipeline.
"""
import os
import json
import tempfile
from typing import List, Tuple
import numpy as np
import soundfile as sf
from transformers import WhisperProcessor


def load_common_voice_samples(
    manifest_path: str,
    processor: WhisperProcessor,
    target_sample_rate: int = 16000,
    max_samples: int = 0
) -> Tuple[List[str], List[str]]:
    """
    Load Common Voice samples from a manifest file for benchmarking.
    
    Args:
        manifest_path: Path to the manifest.json file created by common_voice_downloader.py
        processor: WhisperProcessor for text normalization
        target_sample_rate: Target sample rate for audio (default: 16000)
        max_samples: Maximum number of samples to load (0 = all)
    
    Returns:
        sources: List[str] of paths to .raw files (float32) for each audio
        references: List[str] of reference text transcriptions
    """
    if not os.path.exists(manifest_path):
        raise FileNotFoundError(f"Manifest file not found: {manifest_path}")
    
    # Load manifest
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    
    # Handle two possible manifest formats:
    # 1. New format: flat "samples" array
    # 2. Old format: "dialects" dict with arrays per dialect
    samples = []
    if 'samples' in manifest and manifest['samples']:
        samples = manifest['samples']
    elif 'dialects' in manifest:
        # Flatten dialects into samples array
        for dialect, dialect_samples in manifest['dialects'].items():
            for sample in dialect_samples:
                # Add dialect field if not present
                if 'dialect' not in sample:
                    sample['dialect'] = dialect
                # Rename 'filename' to 'audio_file' if needed
                if 'filename' in sample and 'audio_file' not in sample:
                    sample['audio_file'] = sample['filename']
                # Rename 'sentence' to 'text' if needed
                if 'sentence' in sample and 'text' not in sample:
                    sample['text'] = sample['sentence']
                samples.append(sample)
    
    if not samples:
        raise ValueError(f"No samples found in manifest: {manifest_path}")
    
    # Limit samples if requested
    if max_samples > 0:
        samples = samples[:max_samples]
    
    print(f"Loading {len(samples)} Common Voice samples from {manifest_path}")
    
    # Get the directory containing the audio files
    manifest_dir = os.path.dirname(os.path.abspath(manifest_path))
    
    # Create temporary directory for raw files
    tmp_dir = tempfile.mkdtemp(prefix="common_voice_raw_")
    
    sources: List[str] = []
    references: List[str] = []
    
    for i, sample in enumerate(samples):
        if i % 100 == 0 and i > 0:
            print(f"  Processed {i}/{len(samples)} samples...")
        
        # Get audio file path (relative to manifest)
        audio_filename = sample.get('audio_file', '')
        if not audio_filename:
            print(f"Warning: Sample {i} has no audio_file field, skipping")
            continue
        
        audio_path = os.path.join(manifest_dir, audio_filename)
        if not os.path.exists(audio_path):
            print(f"Warning: Audio file not found: {audio_path}, skipping")
            continue
        
        # Get reference text
        text = sample.get('text', '')
        if not text:
            print(f"Warning: Sample {i} has no text field, skipping")
            continue
        
        # Load audio file (supports WAV, FLAC, etc via soundfile)
        try:
            audio_array, sample_rate = sf.read(audio_path, dtype='float32')
            
            # Resample if needed
            if sample_rate != target_sample_rate:
                import librosa
                audio_array = librosa.resample(
                    audio_array, 
                    orig_sr=sample_rate, 
                    target_sr=target_sample_rate
                )
            
            # Convert to mono if stereo
            if len(audio_array.shape) > 1:
                audio_array = np.mean(audio_array, axis=1)
            
            # Write to raw file (float32)
            sample_id = sample.get('id', f'cv_{i}')
            raw_path = os.path.join(tmp_dir, f"{sample_id}.raw")
            audio_array.astype(np.float32).tofile(raw_path)
            
            sources.append(raw_path)
            references.append(processor.tokenizer.normalize(text))
            
        except Exception as e:
            print(f"Warning: Failed to process {audio_path}: {e}")
            continue
    
    print(f"Successfully loaded {len(sources)} samples")
    
    # Print dialect distribution if available
    dialects = {}
    for sample in samples[:len(sources)]:  # Only count successfully loaded samples
        dialect = sample.get('dialect', 'unknown')
        dialects[dialect] = dialects.get(dialect, 0) + 1
    
    if dialects:
        print("\nDialect distribution:")
        for dialect, count in sorted(dialects.items(), key=lambda x: -x[1]):
            print(f"  - {dialect}: {count} samples")
    
    return sources, references


def load_common_voice_from_dir(
    samples_dir: str,
    processor: WhisperProcessor,
    target_sample_rate: int = 16000,
    max_samples: int = 0
) -> Tuple[List[str], List[str]]:
    """
    Load Common Voice samples from a directory (auto-discovers manifest.json).
    
    Args:
        samples_dir: Directory containing the Common Voice samples and manifest.json
        processor: WhisperProcessor for text normalization
        target_sample_rate: Target sample rate for audio (default: 16000)
        max_samples: Maximum number of samples to load (0 = all)
    
    Returns:
        sources: List[str] of paths to .raw files (float32) for each audio
        references: List[str] of reference text transcriptions
    """
    manifest_path = os.path.join(samples_dir, 'manifest.json')
    return load_common_voice_samples(manifest_path, processor, target_sample_rate, max_samples)


if __name__ == "__main__":
    """
    Example usage:
    
    cd benchmarks/client
    python -m src.whisper.dataset.common_voice_loader
    """
    from transformers import WhisperProcessor
    
    # Example: Load samples from the downloaded Common Voice dataset
    processor = WhisperProcessor.from_pretrained("openai/whisper-tiny")
    
    samples_dir = "../../data/samples/arabic_validated_all"
    if os.path.exists(samples_dir):
        sources, refs = load_common_voice_from_dir(samples_dir, processor, max_samples=10)
        print(f"\nLoaded {len(sources)} sources and {len(refs)} references")
        print(f"Example source: {sources[0]}")
        print(f"Example reference: {refs[0]}")
    else:
        print(f"Samples directory not found: {samples_dir}")
        print("Please run download_cv_samples.py first to download samples")

