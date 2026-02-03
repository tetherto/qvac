# LLM Benchmarking Client

This client tool evaluates Large Language Models (LLMs) on various benchmarks including SQuAD, ARC, MMLU, and GSM8K. It supports both direct HuggingFace model evaluation and server-based evaluation (including P2P model loading).

## Features

- **Multiple Benchmarks**: Evaluate models on SQuAD v2.0, ARC-Challenge, MMLU, and GSM8K
- **Flexible Evaluation Modes**: 
  - Direct HuggingFace model evaluation
  - Server-based evaluation (requires running server)
- **Configurable**: Customize datasets, sample sizes, and model parameters
- **Reproducible Results**: Fixed random seeds for consistent evaluations
- **Progress Tracking**: Real-time progress updates and intermediate results
- **Comprehensive Reporting**: Detailed markdown reports with metrics

## Prerequisites

1. **Python 3.8+**
2. **HuggingFace Account**: You need a HuggingFace account and access token
3. **Dependencies**: Install required packages (see Installation section)

## Installation

1. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Get your HuggingFace token (if using HuggingFace)**:
   - Go to [HuggingFace Settings](https://huggingface.co/settings/tokens)
   - Create a new token with read permissions
   - Copy the token for use in evaluations

## Configuration

### Config File (`config.yaml`)

The configuration file controls evaluation parameters:

```yaml
server:
  temperature: 0.7
  top_p: 0.9
  context_window_size: 8000
  prefill_chunk_size: 1024
  max_tokens: 500
  lib: "@tetherto/qvac-lib-inference-addon-mlc-llama-3_2_1b-q4f16_1"

model_config:
  gpu_layers: "99"
  ctx_size: "2048"
  temp: "0.7"
  top_p: "0.9"
  system_prompt: "You are a helpful assistant."

benchmark:
  num_samples: 100  # Number of samples per dataset
  datasets:
    - gsm8k
    - mmlu
    - squad
    - arc
```

### Configuration Options

- **num_samples**: Number of questions to evaluate per dataset (use smaller numbers for quick testing)
- **datasets**: List of datasets to evaluate on
- **server parameters**: Model generation parameters (temperature, top_p, etc.)
`model_config` is used for P2P model loading and is sent to the server automatically.

## Usage

### Basic Usage

```bash
python evaluate_llama.py --hf-token YOUR_HF_TOKEN_HERE
```

### Advanced Usage

```bash
# Evaluate a specific model
python evaluate_llama.py --hf-token YOUR_TOKEN --model "meta-llama/Llama-3.2-3B-Instruct"

# Evaluate HuggingFace model directly (not server-based)
python evaluate_llama.py --hf-token YOUR_TOKEN --eval-hf-model

# Use custom config file
python evaluate_llama.py --hf-token YOUR_TOKEN --config /path/to/config.yaml

# Quick test with fewer samples (modify config.yaml)
python evaluate_llama.py --hf-token YOUR_TOKEN

# P2P model mode (loads model via Hyperdrive)
python evaluate_llama.py --hyperdrive-key "hd://your-key" --model-name "your-model.gguf"
# Example
python evaluate_llama.py --hyperdrive-key "hd://b11388de0e9214d8c2181eae30e31bcd49c48b26d621b353ddc7f01972dddd76" --model-name "medgemma-4b-it-Q4_1.gguf"
```

### Command Line Arguments

| Argument          | Required | Default                              | Description                                 |
|-------------------|----------|--------------------------------------|---------------------------------------------|
| `--hf-token`      | No       | -                                    | HuggingFace access token                    |
| `--model`         | No       | `meta-llama/Llama-3.2-3B-Instruct`   | Model to evaluate                           |
| `--eval-hf-model` | No       | False                                | Evaluate HuggingFace model directly         |
| `--hyperdrive-key`| No       | -                                    | P2P model Hyperdrive key                    |
| `--model-name`    | No       | -                                    | P2P model GGUF filename                     |
| `--config`        | No       | `config.yaml`                        | Path to configuration file                  |

## Benchmarks

### 1. SQuAD v2.0 (Question Answering)
- **Metric**: Exact Match and F1 Score
- **Task**: Answer questions based on given context
- **Format**: Multiple choice with "cannot answer" option

### 2. ARC-Challenge (Reasoning)
- **Metric**: Accuracy
- **Task**: Multiple choice science questions
- **Format**: A, B, C, D choices

### 3. MMLU (Multi-task Language Understanding)
- **Metric**: Accuracy
- **Task**: Multiple choice questions across various subjects
- **Format**: A, B, C, D choices

### 4. GSM8K (Math Problem Solving)
- **Metric**: Accuracy
- **Task**: Step-by-step math problem solving
- **Format**: Free-form numerical answers

## Output and Results


## Troubleshooting

### Common Issues

1. **HuggingFace Token Error**:
   ```
   Error: HuggingFace token is required for running hf models
   ```
   - Ensure you have a valid HuggingFace token
   - Check token permissions (read access required)

2. **Model Access Error**:
   ```
   Error: Model not found or access denied
   ```
   - Verify model name is correct
   - Ensure you have access to the model on HuggingFace
   - Check if model requires special access permissions

3. **Server Connection Error**:
   ```
   Error: Cannot connect to server
   ```
   - Ensure server is running (if not using `--eval-hf-model`)
   - Check server configuration and port
   - kill all bare processes and restart

4. **Failed To Eval Error**
   ```
   process : failed to eval
   ```
   - Ensure enough context size is given to the p2p model
   - kill all bare processes and restart
   
### Performance Tips

1. **Quick Testing**: Set `num_samples: 10` in config for fast testing
2. **Full Evaluation**: Use `num_samples: 1000` or higher for comprehensive results
3. **Progress Monitoring**: Results are logged every 10 samples

## Development

### Adding New Benchmarks

1. Create evaluation method in `ModelEvaluator` class
2. Add benchmark to config file
3. Update results handler for new metrics
4. Add to main evaluation loop
