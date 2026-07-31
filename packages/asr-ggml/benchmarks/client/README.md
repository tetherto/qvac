# ASR GGML Benchmark Client

A Python client for benchmarking the `@qvac/asr-ggml` addon. One dispatcher
entrypoint (`src.main`) serves both engines — Whisper and NVIDIA Parakeet —
selected by the required top-level `engine:` key in the YAML config. It sends
requests to the benchmark server using multiple datasets (LibriSpeech and
Google FLEURS; Common Voice for the Arabic Whisper configs) and evaluation
metrics.

## Features

- HTTP client for the asr-ggml benchmark server
- Engine-keyed configs: `config/config-whisper*.yaml` and
  `config/config-parakeet*.yaml`
- Multiple dataset support:
  - [LibriSpeech](https://huggingface.co/datasets/openslr/librispeech_asr) dataset integration
  - [Google FLEURS](https://huggingface.co/datasets/google/fleurs) multilingual dataset integration
  - Common Voice manifests (Arabic dialect benchmarks, whisper engine)
- Whisper: 11 languages, WER / CER / AraDiaWER metrics, VAD support
- Parakeet: tdt / ctc / eou / sortformer model types, WER / CER metrics
- Configurable batch processing

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/asr-ggml/benchmarks/client

# Install poetry if you haven't already
curl -sSL https://install.python-poetry.org | python3 -

# Install dependencies
poetry install
```

## Usage

Run a benchmark with:

```bash
# Whisper
poetry run python -u -m src.main --config config/config-whisper.yaml

# Parakeet
poetry run python -u -m src.main --config config/config-parakeet.yaml
```

The dispatcher requires the config's top-level `engine:` key
(`"whisper"` or `"parakeet"`) and errors out if it is missing — there is no
engine sniffing. The engine modules can also be invoked directly
(`python -m src.whisper.main` / `python -m src.parakeet.main`).

The client will:

1. Load the specified dataset and convert it to raw audio files
2. Send paths to audio files to the server for transcription
3. Calculate WER/CER (and AraDiaWER for Arabic, whisper engine)
4. Report timing statistics

## Configuration

Shipped configs:

| Config | Engine | Purpose |
|---|---|---|
| `config-whisper.yaml` | whisper | LibriSpeech/FLEURS baseline |
| `config-whisper-arabic.yaml` | whisper | Common Voice Arabic (validated) |
| `config-whisper-arabic-levantine.yaml` | whisper | Common Voice Levantine Arabic |
| `config-whisper-arabic-egyptian.yaml` | whisper | Common Voice Egyptian Arabic |
| `config-parakeet.yaml` | parakeet | TDT baseline |
| `config-parakeet-ctc.yaml` | parakeet | CTC |
| `config-parakeet-eou.yaml` | parakeet | EOU (streaming) |
| `config-parakeet-sortformer.yaml` | parakeet | Sortformer diarization |

Common structure (whisper example):

```yaml
engine: "whisper"
server:
  url: "http://localhost:8080/run"
  batch_size: 10
  lib: "@qvac/asr-ggml"
dataset:
  dataset_type: "librispeech"   # librispeech or fleurs
  speaker_group: "clean"
  language: "english"
  max_samples: 0                # 0 = unlimited
wer:
  enabled: true
cer:
  enabled: true
model:
  path: "../../models/ggml-tiny.bin"
  sample_rate: 16000
  audio_format: "f32le"
  vad_model_path: ""
  language: "en"
  streaming: false
  streaming_chunk_size: 64000
```

The parakeet `model` block differs: `path` points at a single `.gguf`
checkpoint (the addon auto-detects the model type from GGUF metadata) and
carries `model_type`, `max_threads`, `use_gpu`, `caption_enabled`,
`timestamps_enabled` instead of the VAD/language keys.

### Configuration Details

- **Server**:
  - `url`: The URL of the benchmark server (`/run`)
  - `batch_size`: The number of audio files to transcribe in each request
  - `lib`: The addon library to use (`@qvac/asr-ggml`)
  - `version`: Optional addon version string (informational)
  - `timeout`: HTTP request timeout in seconds

- **Dataset**:
  - `dataset_type`: `librispeech`, `fleurs` (whisper additionally supports
    `common_voice` with `common_voice_manifest`)
  - `speaker_group`: LibriSpeech speaker subset (`clean`, `other`, `all`)
  - `language`: Dataset language (English, French, German, Spanish, Italian,
    Portuguese, Mandarin Chinese, Russian, Japanese, Czech; whisper also
    supports Arabic)
  - `max_samples`: Maximum number of samples to process (0 = unlimited)

- **Metrics**: `wer.enabled`, `cer.enabled`, and (whisper, Arabic only)
  `aradiawer.enabled` + `aradiawer.min_score_threshold`

- **Model (whisper)**: `path`, `sample_rate`, `audio_format`
  (`f32le`/`s16le`), `vad_model_path`, `language`, `streaming`,
  `streaming_chunk_size`

- **Model (parakeet)**: `path` (`.gguf` file), `sample_rate`, `audio_format`,
  `model_type` (`tdt`/`ctc`/`eou`/`sortformer`), `max_threads`, `use_gpu`,
  `caption_enabled`, `timestamps_enabled`, `streaming`,
  `streaming_chunk_size`

## Output

- WER / CER scores (if enabled); AraDiaWER details for Arabic whisper runs
- Total model load time
- Total transcription time
- Result markdown files under `../results/<model>/`

## Development

### Running Tests

```bash
poetry run python -m pytest tests/ -v
```

Whisper-side tests live under `tests/whisper/`, parakeet-side tests under
`tests/parakeet/`.

## Acknowledgments

<details>
<summary>Cite as:</summary>

**LibriSpeech:**
```bibtex
@inproceedings{panayotov2015librispeech,
  title={Librispeech: an ASR corpus based on public domain audio books},
  author={Panayotov, Vassil and Chen, Guoguo and Povey, Daniel and Khudanpur, Sanjeev},
  booktitle={Acoustics, Speech and Signal Processing (ICASSP), 2015 IEEE International Conference on},
  pages={5206--5210},
  year={2015},
  organization={IEEE}
}
```

**Google FLEURS:**
```bibtex
@article{conneau2023fleurs,
  title={FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech},
  author={Conneau, Alexis and Ma, Min and Khanuja, Simran and Zhang, Yu and Axelrod, Vera and Dalmia, Siddharth and Riesa, Jason and Rivera, Clara and Bapna, Ankur},
  journal={arXiv preprint arXiv:2205.12446},
  year={2022}
}
```

</details>

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
