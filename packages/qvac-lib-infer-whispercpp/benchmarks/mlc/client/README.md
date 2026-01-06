# Whisper Addon Benchmark Client

A Python client for benchmarking Whisper transcription addons. It sends requests to the Whisper addon server using Librispeech dataset and multiple metrics.

## Features

- HTTP client for Whisper transcription service
- [Librispeech](https://huggingface.co/datasets/openslr/librispeech_asr) dataset integration
- Multiple evaluation metrics (WER, CER)
- Configurable batch processing
- VAD support

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac-lib-inference-addon-mlc-whisper.git
cd qvac-lib-inference-addon-mlc-whisper/benchmarks/client

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
  lib: "@tetherto/qvac-lib-inference-addon-mlc-whisper-tiny-q0f32"
  version: "1.0.0"

dataset:
  speaker_group: "clean"

cer:
  enabled: true

wer:
  enabled: true

vad:
  enabled: true
  lib: "@tetherto/qvac-lib-inference-addon-onnx-silerovad"
  version: "0.4.3"
```

### Configuration Details

- **Server**:
  - `url`: The URL of the Whisper addon server
  - `batch_size`: The number of sentences to translate in each request
  - `lib`: The Whisper addon library to use
  - `version`: The version of the Whisper addon library to use
- **Dataset**:
  - `speaker_group`: Subset of Librispeech speakers based on transcript WER (clean, other, all)
- **CER**:
  - `enabled`: Enable CER score calculation
- **WER**:
  - `enabled`: Enable WER score calculation

## Usage

Run the benchmark with:

```bash
poetry run python -m src.whisper.main --config config/config.yaml
```

The client will:

1. Load the Librispeech dataset and convert it to raw audio files
2. Send paths to audio files to the server for transcription
3. Calculate WER and CER scores
4. Report timing statistics

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

</details>

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
