# TTS Benchmark Client

Python client for benchmarking TTS addon vs Python native implementation.

## Installation

```bash
pip install -r requirements.txt
```

Or with Poetry:
```bash
poetry install
```

## Configuration

Edit `config/config-chatterbox.yaml`:

```yaml
server:
  addon_url: "http://localhost:8080/synthesize-chatterbox"
  python_url: "http://localhost:8081/synthesize-chatterbox"
  timeout: 600
  batch_size: 1

comparison:
  enabled: true
  run_addon: true
  run_python: true

dataset:
  name: "harvard"
  split: "test"
  max_samples: 1

model:
  modelDir: "shared-data/models/chatterbox"
  referenceAudioPath: "assets/ref.wav"
  language: "en"
  sampleRate: 24000
```

## Usage

Ensure both servers are running, then:

```bash
python -m src.tts.main --config config/config-chatterbox.yaml
```

Or with Poetry:
```bash
poetry run python -m src.tts.main --config config/config-chatterbox.yaml
```

## Output

Reports are saved to `../results/`:

- `{model}_addon.md` - Addon performance
- `{model}_python-native.md` - Python native performance
- `{model}_comparison.md` - Side-by-side comparison

## Metrics

**RTF (Real-Time Factor)** = `audio_duration / generation_time`

- RTF > 1.0 = faster than real-time (generate more than 1 s of audio per 1 s of compute)
- Higher is better

**Speed** = `1 / RTF` = how many times faster than real-time (higher is better)

## Datasets

The benchmark supports multiple datasets for testing:

### Harvard Sentences (Default - Recommended)
- **Size**: ~7 KB (hardcoded, no download needed)
- **Count**: 72 phonetically balanced sentences
- **Content**: Classic speech testing sentences covering all English phonemes
- **Best for**: Fast, comprehensive phonetic testing
- **Config**: `name: "harvard"`

### AG News
- **Size**: ~30 MB download
- **Count**: 7,600 news articles
- **Content**: News headlines and articles
- **Best for**: Testing with formal, varied content
- **Config**: `name: "ag_news"`

### LibriSpeech
- **Size**: ~350 MB download
- **Count**: 2,620+ utterances
- **Content**: Natural audiobook transcripts
- **Best for**: Large-scale testing with natural speech patterns
- **Config**: `name: "librispeech"`

To change dataset, edit `config/config-chatterbox.yaml`:

```yaml
dataset:
  name: "harvard"
  max_samples: 0
```
