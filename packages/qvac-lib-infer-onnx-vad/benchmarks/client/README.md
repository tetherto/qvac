# SileroVAD Addon Benchmark Client

A Python client for benchmarking SileroVAD (Voice Activity Detection) addons. It sends requests to the SileroVAD addon server using AISHELL-4 dataset and provides comprehensive VAD evaluation metrics.

## Features

- HTTP client for SileroVAD service
- [AISHELL-4](https://www.openslr.org/111/) dataset integration for VAD evaluation
- Comprehensive VAD evaluation metrics:
  - Overall accuracy and ROC-AUC
  - Speech/Silence precision, recall, and F1-scores
  - Confusion matrix analysis
  - Per-file detailed statistics
- Configurable batch processing
- Detailed markdown report generation
- Verbose and summary reporting modes

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
  batch_size: 5
  timeout: 30
  lib: "@tetherto/qvac-lib-inference-addon-onnx-silerovad"
  version: "0.4.4"
```

### Configuration Details

- **Server**:
  - `url`: The URL of the SileroVAD addon server
  - `batch_size`: The number of audio files to process in each request
  - `timeout`: Request timeout in seconds
  - `lib`: The SileroVAD addon library to use
  - `version`: The version of the SileroVAD addon library to use

## Usage

Run the VAD benchmark with:

```bash
poetry run python main.py --config config/config.yaml
```

### Command Line Options

- `--config`: Path to config file (default: `config/config.yaml`)
- `--output-dir`: Directory to save evaluation results (default: `results`)
- `--cleanup`: Clean up temporary output files after evaluation
- `--no-reports`: Skip generating detailed reports (only print summary)
- `--verbose` or `-v`: Enable verbose output with detailed per-file results

### Examples

```bash
# Basic usage
poetry run python main.py

# With verbose output and custom config
poetry run python main.py --config my_config.yaml --verbose

# Generate reports in custom directory
poetry run python main.py --output-dir my_results

# Run without generating detailed reports
poetry run python main.py --no-reports

# Clean up temporary files after evaluation
poetry run python main.py --cleanup
```

## Evaluation Process

The client will:

1. Load the AISHELL-4 test dataset with VAD ground truth labels
2. Send audio file paths to the SileroVAD server for processing
3. Compare predicted VAD outputs with ground truth references
4. Calculate comprehensive evaluation metrics:
  - Overall accuracy and ROC-AUC scores
  - Speech detection performance (precision, recall, F1)
  - Silence detection performance (precision, recall, F1)
  - Confusion matrix analysis
  - Per-file statistics and error analysis
5. Generate detailed markdown report with results

## Output

### Console Output
- Files processed summary
- Overall accuracy percentage
- Speech F1-Score
- Total processing time
- Report file location

### Generated Reports
- **results_summary.md**: Comprehensive markdown report including:
  - Model information and performance metrics
  - Overall and per-class performance statistics
  - Data distribution analysis
  - Confusion matrix
  - Per-file detailed results table (when using `--verbose`)

### Metrics Included
- **Overall Performance**: Accuracy, ROC-AUC
- **Speech Detection**: Precision, Recall, F1-Score
- **Silence Detection**: Precision, Recall, F1-Score
- **Distribution Analysis**: Speech ratio predictions vs. ground truth
- **Per-File Analysis**: Individual file performance and error reporting

## Development

### Project Structure
```
src/
├── client.py          # SileroVAD HTTP client
├── config.py          # Configuration management
├── vad_metrics.py     # VAD evaluation metrics calculation
├── reports_summary.py # Markdown report generation
└── dataset/
    └── dataset.py     # AISHELL-4 dataset loading
```

## Dataset Information

This benchmark uses the AISHELL-4 dataset, which provides:
- Multi-channel audio recordings
- Ground truth VAD annotations
- Diverse acoustic conditions
- Support for comprehensive VAD evaluation

## Acknowledgments

<details>
<summary>Cite AISHELL-4 Dataset:</summary>

```bibtex
@inproceedings{fu2021aishell,
  title={AISHELL-4: An Open Source Dataset for Speech Enhancement, Separation, Recognition and Speaker Diarization in Conference Scenario},
  author={Fu, Yihui and Cheng, Luyao and Lv, Shubo and Jv, Yukai and Kong, Yuxiang and Chen, Zhuo and Hu, Yanxin and Xie, Lei and Wu, Jian and Bu, Hui and others},
  booktitle={Interspeech},
  year={2021}
}
```

</details>

<details>
<summary>Cite SileroVAD:</summary>

```bibtex
@misc{silero2021,
  title={Silero VAD: pre-trained enterprise-grade Voice Activity Detector (VAD), Number Detector and Language Classifier},
  author={Silero Team},
  year={2021},
  url={https://github.com/snakers4/silero-vad}
}
```

</details>

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
