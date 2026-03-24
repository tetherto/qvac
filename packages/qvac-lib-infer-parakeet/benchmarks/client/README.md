# Parakeet Addon Benchmark Client

A Python client for benchmarking Parakeet transcription addons. It sends requests to the Parakeet addon server using multiple datasets (LibriSpeech and Google FLEURS) and evaluation metrics.

## Features

- HTTP client for Parakeet transcription service
- Multiple dataset support:
  - [LibriSpeech](https://huggingface.co/datasets/openslr/librispeech_asr) dataset integration
  - [Google FLEURS](https://huggingface.co/datasets/google/fleurs) multilingual dataset integration
- Support for 10 languages: English, French, German, Spanish, Italian, Portuguese, Mandarin Chinese, Russian, Japanese, and Czech
- Multiple evaluation metrics (WER, CER)
- Configurable batch processing
- Streaming mode support

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/qvac-lib-infer-parakeet/benchmarks/client

# Install poetry if you haven't already
curl -sSL https://install.python-poetry.org | python3 -

# Install dependencies
poetry install
```

## Configuration

Create a `config.yaml` file with the following structure:

```yaml
server:
  url: "http://localhost:8080/run"
  timeout: 60
  batch_size: 10
  lib: "@qvac/transcription-parakeet"
  version: "0.1.0"

dataset:
  dataset_type: "librispeech"
  speaker_group: "clean"
  language: "english"
  max_samples: 0

cer:
  enabled: true

wer:
  enabled: true

model:
  path: "./models/parakeet-tdt-0.6b-v3-onnx"
  sample_rate: 16000
  audio_format: "f32le"
  model_type: "tdt"
  max_threads: 4
  use_gpu: false
  caption_enabled: false
  timestamps_enabled: true
  streaming: false
  streaming_chunk_size: 64000
```

### Configuration Details

- **Server**:
  - `url`: The URL of the Parakeet addon server
  - `timeout`: HTTP request timeout in seconds (default: 60)
  - `batch_size`: The number of audio files to transcribe in each request
  - `lib`: The Parakeet addon library to use
  - `version`: The version of the Parakeet addon library to use

- **Dataset**:
  - `dataset_type`: Dataset to use (`librispeech` or `fleurs`)
  - `speaker_group`: Subset of LibriSpeech speakers based on transcript WER (`clean`, `other`, `all`) - only used for LibriSpeech
  - `language`: Dataset language - supports:
    - **LibriSpeech/Multilingual LibriSpeech**: `english`, `french`, `german`, `spanish`, `italian`, `portuguese`
    - **FLEURS**: All languages above plus `mandarin_chinese`, `russian`, `japanese`, `czech`
  - `max_samples`: Maximum number of samples to process (0 = unlimited)

- **CER**:
  - `enabled`: Enable Character Error Rate calculation

- **WER**:
  - `enabled`: Enable Word Error Rate calculation

- **Model**:
  - `path`: Path to the Parakeet model directory (e.g., parakeet-tdt-0.6b-v3-onnx)
  - `sample_rate`: Audio sample rate in Hz (default: 16000)
  - `audio_format`: Audio format (`f32le` or `s16le`)
  - `model_type`: Model architecture type (`tdt`, `ctc`, `eou`, `sortformer`)
  - `max_threads`: Maximum CPU threads for inference (default: 4)
  - `use_gpu`: Enable GPU acceleration (default: false)
  - `caption_enabled`: Enable caption/subtitle mode
  - `timestamps_enabled`: Include timestamps in output (default: true)
  - `streaming`: Enable streaming mode for chunked processing
  - `streaming_chunk_size`: Chunk size in bytes for streaming mode (default: 64000)

## Usage

Run the benchmark with the default TDT config:

```bash
poetry run python -m src.parakeet.main --config config/config.yaml
```

### Per-Model Config Files

Each model type has a dedicated config file with appropriate defaults:

| Config File | Model Type | Description |
|-------------|------------|-------------|
| `config/config.yaml` | TDT | Token-and-Duration Transducer (default) |
| `config/config-ctc.yaml` | CTC | Connectionist Temporal Classification |
| `config/config-eou.yaml` | EOU | End-of-Utterance streaming model |
| `config/config-sortformer.yaml` | Sortformer | Speaker diarization (WER/CER disabled) |

Run a specific model benchmark:

```bash
# CTC benchmark
poetry run python -m src.parakeet.main --config config/config-ctc.yaml

# EOU benchmark (streaming enabled by default)
poetry run python -m src.parakeet.main --config config/config-eou.yaml

# Sortformer benchmark (diarization, no WER/CER)
poetry run python -m src.parakeet.main --config config/config-sortformer.yaml
```

The client will:

1. Load the specified dataset (LibriSpeech or FLEURS) and convert it to raw audio files
2. Send paths to audio files to the server for transcription
3. Calculate WER and CER scores (when enabled)
4. Report timing statistics

### Using Different Datasets and Languages

To benchmark with FLEURS instead of LibriSpeech, update your config:

```yaml
dataset:
  dataset_type: "fleurs"
  language: "mandarin_chinese"
```

### Using Different Model Types

Parakeet supports multiple model architectures:

```yaml
model:
  model_type: "ctc"  # or "tdt", "eou", "sortformer"
```

### Trigger Script

Trigger benchmarks from the command line using the script in `../../scripts/`:

```bash
# Trigger a single model type
../../scripts/trigger-benchmark.sh -t ctc

# Trigger all model types in one run
../../scripts/trigger-benchmark.sh -t all

# With custom sample count and watch mode
../../scripts/trigger-benchmark.sh -t eou -m 100 -W
```

## Output

- WER score (if enabled)
- CER score (if enabled)
- Total model load time
- Total transcription time
- Results saved to `benchmarks/results/<model_name>/` as markdown files

## Development

### Running Tests

```bash
poetry run python -m pytest tests/ -v
```

## Model Types

| Type | Description | Best For |
|------|-------------|----------|
| `tdt` | Token-and-Duration Transducer | General purpose, multilingual, accurate |
| `ctc` | Connectionist Temporal Classification | English-only, faster inference |
| `eou` | End-of-Utterance | Streaming, low latency with utterance detection |
| `sortformer` | Sortformer architecture | Speaker diarization (no WER/CER metrics) |

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

**NVIDIA Parakeet:**
```bibtex
@misc{nvidia_parakeet,
  title={NVIDIA NeMo Parakeet Models},
  author={NVIDIA},
  year={2024},
  url={https://huggingface.co/nvidia/parakeet-tdt-0.6b}
}
```

</details>

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
