# Aggregated Benchmark Results

This summary consolidates benchmarking results across all quantizations and speaker groups.

Original Model: [Whisper-Tiny](https://huggingface.co/openai/whisper-tiny)

| Speaker group | Quantization | Version | Model | VAD | WER | CER | Dataset | Notes |
|---------------|--------------|---------|-------|-----|-----|-----|---------|-------|
| clean | q0f32 | 1.3.3 | whisper-tiny | - | 99.99 | 97.00 | Librispeech | Performed on GPU |
| clean | q0f32 | 1.3.3 | whisper-tiny | ✓ | 99.99 | 96.99 | Librispeech | Performed on GPU |
| other | q0f32 | 1.3.3 | whisper-tiny | - | 37.81 | 25.42 | Librispeech | Performed on GPU |
| other | q0f32 | 1.3.3 | whisper-tiny | ✓ | 40.93 | 28.32 | Librispeech | Performed on GPU |

## Whisper.cpp Results

| Speaker group | Quantization | Version | Model | VAD | WER | CER | Dataset | Notes |
|---------------|--------------|---------|-------|-----|-----|-----|---------|-------|
| clean | whispercpp | 3.1.1 | @tetherto/transcription-whispercpp | - | 71.72 | 69.27 | Librispeech | Performed on GPU |
| clean | whispercpp | 3.1.1 | @tetherto/transcription-whispercpp | ✓ | 62.30 | 57.87 | Librispeech | Performed on GPU |

## Reference

### WER (Word Error Rate)

Measures the fraction of word-level substitutions, deletions, and insertions vs. a reference transcription

Range: 0 – 100, **Lower = better**

| **Score Range** | **Interpretation** |
|----------------|--------------------|
| 0 – 5   | Excellent; near human-parity transcription |
| 5 – 15  | High quality; minor word errors |
| 15 – 30 | Adequate; understandable but noticeable mistakes |
| > 30    | Low quality; transcript often unreliable |

### CER (Character Error Rate)

Same formula as WER but computed on characters instead of words

Range: 0 – 100, **Lower = better**

| **Score Range** | **Interpretation** |
|----------------|--------------------|
| 0 – 2   | Excellent; virtually no character errors |
| 2 – 10  | High quality; few character mistakes |
| 10 – 20 | Adequate; visible errors that may need correction |
| > 20    | Low quality; many character errors |

### Speaker Group

The speaker group is a classification introduced by the LibriSpeech authors, who automatically ranked speakers based on the WER from a WSJ-trained ASR model applied to their recordings.

| Speaker Group | Description |
|---------------|-------------|
| clean         | Speakers with **lower WER** |
| other         | Speakers with **higher WER** |
| all           | Full corpus: both *clean* and *other* segments combined. |

### VAD (Voice Activity Detection)

VAD is a technique used to identify and separate speech from non-speech segments in audio. It is often used in speech recognition systems to improve accuracy by reducing the impact of background noise and other non-speech sounds.

Addon: internal

Version: 

| VAD | Description |
|-----|-------------|
| ✓   | VAD is enabled |
| -   | VAD is disabled |
