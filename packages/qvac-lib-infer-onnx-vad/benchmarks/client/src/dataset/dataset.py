from datasets import load_dataset
import aiohttp
import os
import numpy as np
import tempfile
from typing import List, Tuple


def write_raw_file(array, clip_id: str, output_dir: str) -> str:
    """
    Write a float64/array audio to a 32-bit LE .raw file

    Args:
        array:    NumPy array of audio samples
        clip_id:  unique identifier for naming
        output_dir: directory in which to write

    Returns:
        str: Full path to the written .raw file
    """
    out_path = os.path.join(output_dir, f"{clip_id}.raw")
    array.astype(np.float32).tofile(out_path)
    return out_path


def load_aishell_4_dataset() -> Tuple[List[str], List[List[int]], List[List[float]]]:
    """
    Loads the AISHELL-4 test dataset with VAD ground truth for ROC-AUC evaluation.

    Returns:
        Tuple containing:
        - sources: List[str] of paths to .raw audio files
        - vad_references: List[List[int]] of VAD ground truth labels (0=silence, 1=speech)
        - vad_timestamps: List[List[float]] of timestamps for each VAD frame
    """
    print("Loading AISHELL-4 test dataset...")

    # Load the dataset
    ds = load_dataset(
        "src/dataset/aishell_4_data_loader.py",
        name='test',
        split="test",
        trust_remote_code=True,
        storage_options={'client_kwargs': {'timeout': aiohttp.ClientTimeout(total=3600)}}
    )

    # Create temporary directory for audio files
    temp_dir = tempfile.mkdtemp(prefix="aishell4_vad_")
    print(f"Writing audio files to temporary directory: {temp_dir}")

    sources = []
    vad_references = []
    vad_timestamps = []

    for idx, example in enumerate(ds):
        try:
            # Get audio data
            audio_data = example['audio']['array']  # NumPy array
            session_id = example['session_id']

            # Write audio to .raw file
            clip_id = f"{session_id}_ch{example['channel']}"
            audio_path = write_raw_file(audio_data, clip_id, temp_dir)
            sources.append(audio_path)

            # Get VAD ground truth
            vad_labels = example['vad_labels']  # List[int] - 0=silence, 1=speech
            timestamps = example['vad_timestamps']  # List[float] - timestamp for each frame

            vad_references.append(vad_labels)
            vad_timestamps.append(timestamps)

            # Print progress and sample info
            speech_ratio = sum(vad_labels) / len(vad_labels) if vad_labels else 0
            print(f"  Example {idx + 1}:")
            print(f"    Session: {session_id}, Channel: {example['channel']}")
            print(f"    Duration: {example['duration']:.2f}s")
            print(f"    Audio path: {audio_path}")
            print(f"    VAD frames: {len(vad_labels)}, Speech ratio: {speech_ratio:.3f}")
            print(f"    Frame rate: {example['vad_frame_rate']}Hz")
            print(f"    Speech segments: {len(example['speech_segments'])}")

        except Exception as e:
            print(f"Warning: Could not process example {idx}: {e}")
            continue

    print(f"\nLoaded {len(sources)} audio files with VAD ground truth")
    print(f"Average VAD frames per file: {np.mean([len(ref) for ref in vad_references]):.1f}")
    print(f"Overall speech ratio: {np.mean([sum(ref) / len(ref) for ref in vad_references if ref]):.3f}")

    return sources, vad_references, vad_timestamps


def load_aishell_4_for_silero_vad() -> Tuple[List[str], List[np.ndarray]]:
    """
    Loads AISHELL-4 dataset specifically formatted for SileroVAD evaluation.

    Returns:
        Tuple containing:
        - audio_paths: List[str] of paths to audio files (for SileroVAD input)
        - ground_truth_labels: List[np.ndarray] of VAD labels aligned to 31.25ms frames
    """
    sources, vad_references, vad_timestamps = load_aishell_4_dataset()

    # Convert to numpy arrays for easier manipulation
    ground_truth_labels = [np.array(ref, dtype=np.int32) for ref in vad_references]

    print(f"Prepared {len(sources)} audio files for SileroVAD evaluation")
    print(f"Frame rate: 32Hz (31.25ms frames)")

    return sources, ground_truth_labels


if __name__ == "__main__":
    # Test the dataset loading
    sources, vad_refs, timestamps = load_aishell_4_dataset()

    print(f"\nDataset loaded successfully!")
    print(f"Sources: {len(sources)} audio files")
    print(f"VAD references: {len(vad_refs)} label sequences")

    if sources and vad_refs:
        print(f"\nExample:")
        print(f"  Audio path: {sources[0]}")
        print(f"  VAD labels length: {len(vad_refs[0])}")
        print(f"  First 20 VAD labels: {vad_refs[0][:20]}")
        print(f"  Speech ratio: {sum(vad_refs[0]) / len(vad_refs[0]):.3f}")
