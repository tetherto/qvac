# TTS Benchmark Suite

A benchmark suite comparing **TTS ONNX Addon** (@qvac/tts-onnx) against **Python native** (chatterbox-tts) implementation.

## Features

- HTTP servers using bare (addon) and FastAPI (Python native)
- Chatterbox TTS benchmarking with voice cloning
- RTF (Real-Time Factor) performance metrics
- Automated comparison reports

## Setup

### 1. Install Server Dependencies & Download Resources

```bash
cd server
npm install
npm run setup  # Downloads Chatterbox ONNX models
```

### 2. Install Python Dependencies

**Python Native Server:**
```bash
cd ../python-server
pip install -r requirements.txt
pip install -r requirements-chatterbox.txt
```

**Benchmark Client:**
```bash
cd ../client
pip install -r requirements.txt
```

## Usage

### Start Servers

**Terminal 1 - Addon Server:**
```bash
cd server
npm start  # Runs on port 8080
```

**Terminal 2 - Python Server:**
```bash
cd python-server
python main.py  # Runs on port 8081
```

### Run Benchmark

**Terminal 3 - Client:**
```bash
cd client
python -m src.tts.main --config config/config-chatterbox.yaml
```

## Configuration

Edit `client/config/config-chatterbox.yaml`:

```yaml
server:
  addon_url: "http://localhost:8080/synthesize-chatterbox"
  addon_version: "^0.1.0"
  python_url: "http://localhost:8081/synthesize-chatterbox"
  batch_size: 1

comparison:
  run_addon: true
  run_python: true
  round_trip_test: true
  whisper_model: "tiny"

dataset:
  name: "harvard"
  max_samples: 1

model:
  modelDir: "shared-data/models/chatterbox"
  referenceAudioPath: "assets/ref.wav"
  language: "en"
  sampleRate: 24000
```

### Benchmarking Different Addon Versions

#### Manual Benchmarking

To benchmark different versions locally:

1. Update version in `server/package.json`:
   ```json
   "dependencies": {
     "@qvac/tts-onnx": "^0.2.0"
   }
   ```

2. Update expected version in `client/config/config-chatterbox.yaml`:
   ```yaml
   server:
     addon_version: "^0.2.0"
   ```

3. Reinstall and restart:
   ```bash
   cd server
   npm install
   npm start
   ```

The version will be reported in all benchmark results for tracking and comparison.

#### Automated CI/CD Benchmarking

The benchmark workflow (`.github/workflows/benchmark.yaml`) supports two trigger modes:

**1. Manual Dispatch:** Trigger via GitHub Actions UI with custom version:
   - Set `addon_version` parameter (e.g., `0.1.0`, `latest`, `^0.2.0`)
   - The workflow will dynamically install that version

**2. Automatic on Release:** Runs automatically when a new release is published:
   - Automatically extracts version from the release tag (e.g., `v0.1.0` -> `0.1.0`)
   - Benchmarks the newly released version
   - Results are saved as artifacts with version in the name

Example manual workflow dispatch:
```bash
gh workflow run benchmark.yaml \
  -f addon_version="0.2.0" \
  -f dataset="harvard" \
  -f max_samples=50 \
  -f run_addon=true \
  -f run_python=true
```

Benchmark results are uploaded as artifacts: `benchmark-results-v{VERSION}`

## Results

Reports are saved to `results/`:

```
results/
├── {model}_addon.md              # Addon performance
├── {model}_python-native.md      # Python native performance
└── {model}_comparison.md         # Side-by-side comparison
```

Example comparison:

```markdown
| Metric | TTS Addon | Python Native | Difference |
|--------|-----------|---------------|------------|
| Model Load Time | 245.30 ms | 312.70 ms | -21.5% |
| Avg RTF | 18.50 | 22.30 | -17.0% |
| Total Generation | 4523 ms | 3654 ms | +23.8% |
| Real-time Speed | 18.50x | 22.30x | Addon is 0.81x slower |
```

## Metrics

### Performance Metrics

**RTF (Real-Time Factor)** = `audio_duration / generation_time`

- RTF > 1.0 means faster than real-time
- RTF < 1.0 means slower than real-time
- Higher is better
- RTF of 2.0 = 2x faster than real-time (generates 2 seconds of audio in 1 second)

### Quality Metrics (Round-Trip Test)

When `round_trip_test: true`, the benchmark:
1. Generates audio from text using TTS
2. Transcribes audio back to text using Whisper
3. Compares transcription to original using:
   - **WER (Word Error Rate)**: % of words incorrectly transcribed (lower is better)
   - **CER (Character Error Rate)**: % of characters incorrectly transcribed (lower is better)

This validates that the generated audio is intelligible and matches the original text.

**Quality Benchmarks:**
- WER < 5%: Excellent quality
- WER < 10%: Good quality
- WER < 20%: Acceptable quality
- WER > 20%: Poor quality

### Chatterbox: reference audio

For Chatterbox benchmarks, place a reference WAV file at `benchmarks/assets/ref.wav` (or set `model.referenceAudioPath` in `config-chatterbox.yaml` to your path). The server uses this for voice cloning.

## Running Individual Servers

You can run just one server by disabling the other in `config-chatterbox.yaml`:

**Addon only:**
```yaml
comparison:
  run_addon: true
  run_python: false
```

**Python only:**
```yaml
comparison:
  run_addon: false
  run_python: true
```

## Dataset

The benchmark uses [LJSpeech](https://huggingface.co/datasets/lj_speech) from HuggingFace by default. Falls back to sample texts if unavailable.

## Architecture

```
benchmarks/
├── server/                  # Node.js addon server (port 8080)
│   ├── chatterbox-setup.js  # Chatterbox: ONNX models download
│   └── src/                 # Server implementation (/synthesize-chatterbox)
├── python-server/           # Python native server (port 8081)
│   ├── requirements.txt
│   └── requirements-chatterbox.txt
├── client/
│   ├── config/
│   │   └── config-chatterbox.yaml
│   └── src/tts/             # Benchmark client
├── assets/                  # Place ref.wav here for Chatterbox
├── shared-data/             # Downloaded models (gitignored)
└── results/                 # Benchmark reports
```

## License

Apache-2.0
