# Aggregated Benchmark Results

This summary consolidates benchmarking results across all model configurations.

| Model | Type | Language | Speaker Group | GPU | Mode | WER | CER | Dataset | Notes |
|-------|------|----------|---------------|-----|------|-----|-----|---------|-------|
| indic-conformer-ctc.q8_0.gguf | indic-conformer | gujarati | clean | - | batch | 10.81 | 6.07 | Fleurs | Model type: indic-conformer, Threads: 4 |
| indic-conformer-ctc.q8_0.gguf | indic-conformer | gujarati | clean | ✓ | batch | 10.81 | 6.07 | Fleurs | Model type: indic-conformer, Threads: 4 |
| indic-conformer-ctc.q8_0.gguf | indic-conformer | hindi | clean | - | batch | 5.43 | 2.97 | Fleurs | Model type: indic-conformer, Threads: 4 |
| indic-conformer-ctc.q8_0.gguf | indic-conformer | hindi | clean | ✓ | batch | 5.37 | 2.97 | Fleurs | Model type: indic-conformer, Threads: 4 |
| indic-conformer-ctc.q8_0.gguf | indic-conformer | kannada | clean | - | batch | 8.47 | 3.65 | Fleurs | Model type: indic-conformer, Threads: 4 |
| indic-conformer-ctc.q8_0.gguf | indic-conformer | kannada | clean | ✓ | batch | 8.65 | 3.67 | Fleurs | Model type: indic-conformer, Threads: 4 |
| indic-conformer-ctc.q8_0.gguf | indic-conformer | tamil | clean | - | batch | 17.96 | 12.04 | Fleurs | Model type: indic-conformer, Threads: 4 |
| indic-conformer-ctc.q8_0.gguf | indic-conformer | tamil | clean | ✓ | batch | 17.96 | 12.04 | Fleurs | Model type: indic-conformer, Threads: 4 |
| parakeet-ctc-0.6b.f16.gguf | ctc | english | clean | - | batch | 1.51 | 0.65 | Librispeech | Model type: ctc, Threads: 4 |
| parakeet-ctc-0.6b.f16.gguf | ctc | english | clean | - | streaming | 1.51 | 0.65 | Librispeech | Model type: ctc, Threads: 4 |
| parakeet-ctc-0.6b.f16.gguf | ctc | english | clean | ✓ | batch | 1.51 | 0.65 | Librispeech | Model type: ctc, Threads: 4 |
| parakeet-eou-120m-v1.f16.gguf | eou | english | clean | - | batch | 3.01 | 1.46 | Librispeech | Model type: eou, Threads: 4 |
| parakeet-eou-120m-v1.f16.gguf | eou | english | clean | - | streaming | 3.01 | 1.46 | Librispeech | Model type: eou, Threads: 4 |
| parakeet-eou-120m-v1.f16.gguf | eou | english | clean | ✓ | streaming | 3.01 | 1.46 | Librispeech | Model type: eou, Threads: 4 |
| parakeet-tdt-0.6b-v3.f16.gguf | tdt | french | clean | - | batch | 5.20 | 2.19 | Fleurs | Model type: tdt, Threads: 4 |
| parakeet-tdt-0.6b-v3.f16.gguf | tdt | german | clean | - | batch | 4.61 | 1.40 | Fleurs | Model type: tdt, Threads: 4 |
| parakeet-tdt-0.6b-v3.f16.gguf | tdt | spanish | clean | - | batch | 3.18 | 1.19 | Fleurs | Model type: tdt, Threads: 4 |
| parakeet-tdt-0.6b-v3.f16.gguf | tdt | english | clean | - | batch | 2.26 | 0.77 | Librispeech | Model type: tdt, Threads: 4 |
| parakeet-tdt-0.6b-v3.f16.gguf | tdt | english | clean | - | streaming | 2.26 | 0.77 | Librispeech | Model type: tdt, Threads: 4 |
| parakeet-tdt-0.6b-v3.f16.gguf | tdt | english | clean | ✓ | batch | 2.26 | 0.77 | Librispeech | Model type: tdt, Threads: 4 |
| parakeet-unified-en-0.6b.f16.gguf | unified | english | clean | - | batch | 2.15 | 0.63 | Librispeech | Model type: unified, Threads: 4 |
| parakeet-unified-en-0.6b.f16.gguf | unified | english | clean | - | streaming | 2.15 | 0.63 | Librispeech | Model type: unified, Threads: 4 |
| parakeet-unified-en-0.6b.f16.gguf | unified | english | clean | ✓ | batch | 2.15 | 0.63 | Librispeech | Model type: unified, Threads: 4 |
| sortformer-4spk-v1.f16.gguf | sortformer | english | clean | - | batch |  |  | Librispeech | Model type: sortformer, Threads: 4 |
| sortformer-4spk-v1.f16.gguf | sortformer | english | clean | ✓ | batch |  |  | Librispeech | Model type: sortformer, Threads: 4 |

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

### Model Types

| Model Type | Description |
|------------|-------------|
| tdt        | Token-and-Duration Transducer (default) |
| unified    | Unified RNN-T; one checkpoint serving batch and low-latency streaming |
| ctc        | Connectionist Temporal Classification |
| eou        | End-of-Utterance detection |
| sortformer | Sortformer architecture |
| indic-conformer | Conformer CTC for Indic languages; requires a model language |
