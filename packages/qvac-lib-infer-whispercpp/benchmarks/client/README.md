# Whisper Addon Benchmark Client

A Python client for benchmarking Whisper transcription addons. It sends requests to the Whisper addon server using multiple datasets (LibriSpeech and Google FLEURS) and evaluation metrics.

## Features

- HTTP client for Whisper transcription service
- Multiple dataset support:
  - [LibriSpeech](https://huggingface.co/datasets/openslr/librispeech_asr) dataset integration
  - [Google FLEURS](https://huggingface.co/datasets/google/fleurs) multilingual dataset integration
- Support for 11 languages: English, French, German, Spanish, Italian, Portuguese, Mandarin Chinese, Arabic, Russian, Japanese, and Czech
- Multiple evaluation metrics (WER, CER)
- Configurable batch processing
- VAD support

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/qvac-lib-infer-whispercpp/benchmarks/client

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
  batch_size: 100
  lib: "@qvac/transcription-whispercpp"
  version: "0.1.7"

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
  path: "./examples/ggml-tiny.bin"
  sample_rate: 16000
  audio_format: "f32le"
  vad_model_path: ""
  language: "en"
  streaming: false
  streaming_chunk_size: 64000
```

### Configuration Details

- **Server**:
  - `url`: The URL of the Whisper addon server
  - `batch_size`: The number of audio files to transcribe in each request
  - `lib`: The Whisper addon library to use
  - `version`: The version of the Whisper addon library to use
  - `timeout`: HTTP request timeout in seconds (default: 90)

- **Dataset**:
  - `dataset_type`: Dataset to use (`librispeech` or `fleurs`)
  - `speaker_group`: Subset of LibriSpeech speakers based on transcript WER (`clean`, `other`, `all`) - only used for LibriSpeech
  - `language`: Dataset language - supports:
    - **LibriSpeech/Multilingual LibriSpeech**: `english`, `french`, `german`, `spanish`, `italian`, `portuguese`
    - **FLEURS**: All languages above plus `mandarin_chinese`, `arabic`, `russian`, `japanese`, `czech`
  - `max_samples`: Maximum number of samples to process (0 = unlimited)

- **CER**:
  - `enabled`: Enable Character Error Rate calculation

- **WER**:
  - `enabled`: Enable Word Error Rate calculation

- **Model**:
  - `path`: Path to the whisper model file (e.g., ggml-tiny.bin)
  - `sample_rate`: Audio sample rate in Hz (default: 16000)
  - `audio_format`: Audio format (`f32le` or `s16le`)
  - `vad_model_path`: Path to VAD model file (empty string to disable)
  - `language`: Language code for transcription (e.g., "en", "fr", "zh" - empty string for auto-detect)
  - `streaming`: Enable streaming mode for chunked processing
  - `streaming_chunk_size`: Chunk size in bytes for streaming mode (default: 64000)

## Usage

Run the benchmark with:

```bash
poetry run python -m src.whisper.main --config config/config.yaml
```

The client will:

1. Load the specified dataset (LibriSpeech or FLEURS) and convert it to raw audio files
2. Send paths to audio files to the server for transcription
3. Calculate WER and CER scores
4. Report timing statistics

### Using Different Datasets and Languages

To benchmark with FLEURS instead of LibriSpeech, update your config:

```yaml
dataset:
  dataset_type: "fleurs"
  language: "mandarin_chinese"
```

## Output

- WER score (if enabled)
- CER score (if enabled)
- Total model load time
- Total transcription time

## Development

### Running Tests

```bash
poetry run python -m pytest tests/ -v
```

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
