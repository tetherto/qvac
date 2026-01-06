import os
import tempfile
from typing import List, Tuple
from datasets import load_dataset, concatenate_datasets
from src.whisper.config import DatasetConfig, Config, SpeakerGroup
import numpy as np
from transformers import WhisperProcessor


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


def load_librispeech_dataset(
    cfg: DatasetConfig, processor: WhisperProcessor
) -> Tuple[List[str], List[str]]:
    """
    Loads the Librispeech test split and writes the audio to a .raw file in a temporary directory.

    Args:
        cfg: DatasetConfig containing:
            - speaker_group: Subset of LibriSpeech speakers based on transcript WER (all, clean, other)

    Returns:
        sources: List[str] of paths to .raw files for each audio record
        references: List[str] of reference text transcriptions
    """
    ds = load_dataset(
        "src/whisper/dataset/librispeech_dataset_builder.py",
        name=cfg.speaker_group.value,
        trust_remote_code=True,
    )

    if cfg.speaker_group == SpeakerGroup.ALL:
        combined_ds = concatenate_datasets([ds["test.clean"], ds["test.other"]])
    else:
        combined_ds = ds["test"]

    tmp_dir = tempfile.mkdtemp(prefix="librispeech_raw_")

    sources: List[str] = []
    references: List[str] = []

    for i in range(len(combined_ds)):
        item = combined_ds[i]
        sources.append(write_raw_file(item["audio"]["array"], item["id"], tmp_dir))
        references.append(processor.tokenizer.normalize(item["text"]))
    return sources, references


if __name__ == "__main__":
    cfg = Config.from_yaml()
    srcs, refs = load_librispeech_dataset(cfg.dataset)
    print(
        f"Loaded {len(srcs)} audio data and corresponding transcriptions from Librispeech."
    )
    print("Example audio data:", srcs[0])
    print("Example transcription:", refs[0])
