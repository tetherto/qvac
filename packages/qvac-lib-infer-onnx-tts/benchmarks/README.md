# TTS Benchmark Suite

A benchmark suite comparing **TTS ONNX Addon** (@qvac/tts-onnx) against **Python native** (piper-tts) implementation.

## Features

- HTTP servers using bare (addon) and FastAPI (Python native)
- Identical eSpeak-ng data and models for fair comparison
- LJSpeech dataset integration
- RTF (Real-Time Factor) performance metrics
- Automated comparison reports

## Setup

### 1. Install Server Dependencies & Download Resources

```bash
cd server
npm install
npm run setup  # Downloads eSpeak-ng data and models via HyperDrive
```

### 2. Install Python Dependencies

**Python Native Server:**
```bash
cd ../python-server
pip install -r requirements.txt
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
python -m src.tts.main --config config/config.yaml
```

## Configuration

Edit `client/config/config.yaml`:

```yaml
server:
  addon_url: "http://localhost:8080/synthesize"
  addon_version: "^0.1.0"   # Expected version of @qvac/tts-onnx addon
  python_url: "http://localhost:8081/synthesize"
  batch_size: 10

comparison:
  run_addon: true           # Set false to skip addon
  run_python: true          # Set false to skip python
  round_trip_test: true     # Use Whisper to validate audio quality
  whisper_model: "base"     # Whisper model: tiny, base, small, medium, large

dataset:
  name: "lj_speech"
  max_samples: 100    # 0 = unlimited

model:
  # Paths relative to benchmarks/ directory
  modelPath: "shared-data/models/model.onnx"
  configPath: "shared-data/models/config.json"
  eSpeakDataPath: "shared-data/espeak-ng-data"
  language: "en"
  sampleRate: 22050
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

2. Update expected version in `client/config/config.yaml`:
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
   - Automatically extracts version from the release tag (e.g., `v0.1.0` → `0.1.0`)
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
| Model Load Time | 245.30 ms | 312.70 ms | -21.5% ✅ |
| Avg RTF | 18.50 | 22.30 | -17.0% ⚠️ |
| Total Generation | 4523 ms | 3654 ms | +23.8% ⚠️ |
| Real-time Speed | 18.50x | 22.30x | Addon is 0.81x slower |
```

Note: In this example, Python is faster (higher RTF = better).
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
- WER < 5%: Excellent quality ✅
- WER < 10%: Good quality ✅
- WER < 20%: Acceptable quality ⚠️
- WER > 20%: Poor quality ❌

## Running Individual Servers

You can run just one server by disabling the other in `config.yaml`:

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
├── server/              # Node.js addon server (port 8080)
│   ├── setup.js        # Downloads shared resources
│   └── src/            # Server implementation
├── python-server/       # Python native server (port 8081)
│   └── src/            # Server implementation
├── client/              # Python benchmark client
│   └── src/tts/        # Client implementation
├── shared-data/         # Downloaded eSpeak + models (gitignored)
└── results/             # Benchmark reports
```

## License

Apache-2.0
