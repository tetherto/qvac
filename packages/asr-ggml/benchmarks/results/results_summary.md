# Aggregated Benchmark Results

This summary consolidates benchmarking results across model configurations.
The Indic Conformer rows use the first 50 FLEURS test samples for each language
on an AMD Ryzen 9 9950X3D CPU with four inference threads.

Original Model: [Whisper-Tiny](https://huggingface.co/openai/whisper-tiny)

| Engine | Speaker group | Quantization | Version | Model | VAD | WER | CER | Dataset | Notes |
|--------|---------------|--------------|---------|-------|-----|-----|-----|---------|-------|
| whisper | clean | whispercpp | 3.1.1 | @qvac/transcription-whispercpp | - | 71.72 | 69.27 | LibriSpeech | Performed on GPU |
| whisper | clean | whispercpp | 3.1.1 | @qvac/transcription-whispercpp | ✓ | 62.30 | 57.87 | LibriSpeech | Performed on GPU |
| parakeet | clean | q8_0 | 0.2.0 | indic-conformer-ctc | - | 5.37 | 2.97 | FLEURS Hindi | CPU, 50 samples |
| parakeet | clean | q8_0 | 0.2.0 | indic-conformer-ctc | - | 10.81 | 6.07 | FLEURS Gujarati | CPU, 50 samples |
| parakeet | clean | q8_0 | 0.2.0 | indic-conformer-ctc | - | 8.65 | 3.67 | FLEURS Kannada | CPU, 50 samples |
| parakeet | clean | q8_0 | 0.2.0 | indic-conformer-ctc | - | 17.96 | 12.04 | FLEURS Tamil | CPU, 50 samples |

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
