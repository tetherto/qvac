# @qvac/bci-whispercpp

Brain-Computer Interface (BCI) neural signal transcription addon for qvac, powered by the [tetherto/qvac-ext-lib-whisper.cpp](https://github.com/tetherto/qvac-ext-lib-whisper.cpp) fork of whisper.cpp.

Transcribes multi-channel neural signals (e.g., 512-channel microelectrode array recordings) into text using a BCI-trained whisper model running natively via GGML. Output matches the Python BrainWhisperer reference model exactly.

## Architecture

```
Neural Signal (512ch, 20ms bins)
    │
    ▼
┌──────────────────────────────┐
│   NeuralProcessor (C++)      │
│   - Gaussian smoothing       │  std=2, kernel=100
│   - Day-specific projection  │  low-rank (A·B) + month + softsign
│   - Pad to 3000 frames       │  mel-major layout for whisper.cpp
└──────────────┬───────────────┘
               │  mel features (512 × 3000)
               ▼
┌──────────────────────────────┐
│   whisper.cpp (patched)      │
│   - conv1 (k=7, 512→384)    │  BCI-trained embedder weights
│   - conv2 (k=3, stride=2)   │
│   - Positional encoding      │  learned time PE + sinusoidal day PE
│   - 6-layer encoder          │  windowed attention (w=57) on layers 0–3
│   - 4-layer decoder (LoRA)   │  beam search, length_penalty=0.14
└──────────────┬───────────────┘
               │
               ▼
          Text output
```

## Results

Native GGML inference matches the Python BrainWhisperer reference on all test samples:

| Sample | Ground Truth | GGML Native Output | WER |
|--------|-------------|-------------------|-----|
| 0 | "You can see the code at this point as well." | "You can see the good at this point as well." | 10.0% |
| 1 | "How does it keep the cost down?" | "How does it keep the cost down?" | 0.0% |
| 2 | "Not too controversial." | "Not too controversial." | 0.0% |
| 3 | "The jury and a judge work together on it." | "The jury and a judge work together on it." | 0.0% |
| 4 | "Were quite vocal about it." | "We're quite vocal about it." | 20.0% |
| **Average** | | | **6.0%** |

## Neural Signal Format

Binary files with the following layout:

| Offset | Type      | Description                                          |
|--------|-----------|------------------------------------------------------|
| 0      | uint32    | Number of timesteps                                  |
| 4      | uint32    | Number of channels                                   |
| 8      | float32[] | Feature data (row-major: `features[t * channels + c]`) |

Each timestep represents a 20ms bin of neural activity. Channels correspond to individual electrodes in a microelectrode array (typically 512 channels).

## Installation

```bash
cd packages/bci-whispercpp
npm install
VCPKG_ROOT=/path/to/vcpkg npm run build
```

### Prerequisites

- **Bare runtime** >= 1.24.0
- **CMake** >= 3.25
- **vcpkg** with `VCPKG_ROOT` environment variable set

### Model Conversion Prerequisites

- **Python 3** with `numpy`, `torch`, and `transformers` (`pip install numpy torch transformers`)

### Model Conversion

Convert a trained BrainWhisperer checkpoint. This produces **two files**, both required for inference:

| File | Size | Description |
|------|------|-------------|
| `ggml-bci-windowed.bin` | ~84 MB | GGML model: whisper encoder/decoder (LoRA-merged), tokenizer, positional embedding, windowed attention header |
| `bci-embedder.bin` | ~24 MB | Day projection weights: low-rank A·B matrices per recording day, month projections, session-to-day mapping |

```bash
python3 scripts/convert-model.py \
  --checkpoint /path/to/epoch=93-val_wer=0.0910.ckpt
```

Both files are written to `models/` by default. All flags are optional:

| Flag | Default | Description |
|------|---------|-------------|
| `--output` | `models/ggml-bci-windowed.bin` | GGML model output path |
| `--embedder-output` | `models/bci-embedder.bin` | Embedder weights output path |
| `--day-idx` | `1` | Day index for baked positional embedding |
| `--window-size` | `57` | Windowed attention size (0 to disable) |
| `--last-window-layer` | `3` | Last encoder layer with windowed attention |
| `--f32` | off | Use f32 for all tensors (avoids f16 precision loss, ~2x larger) |

**Important:** Both files must be in the same directory at runtime. The C++ addon looks for `bci-embedder.bin` next to the GGML model file and will fail if it is missing.

## Usage

### Low-level API (BCIInterface)

```javascript
const { BCIInterface } = require('@qvac/bci-whispercpp/bci')
const binding = require('@qvac/bci-whispercpp/binding')

const config = {
  contextParams: { model: '/path/to/ggml-bci.bin' },
  whisperConfig: { language: 'en', temperature: 0.0 },
  miscConfig: { caption_enabled: false },
  bciConfig: { day_idx: 1 }
}

const onOutput = (addon, event, jobId, data, error) => {
  if (event === 'Output') console.log('Segment:', data[0]?.text)
  if (event === 'JobEnded') console.log('Done:', data)
  if (event === 'Error') console.error('Error:', error)
}

const model = new BCIInterface(binding, config, onOutput)
await model.activate()

// Batch mode — pass entire signal at once
const neuralData = fs.readFileSync('signal.bin')
await model.runJob({ input: new Uint8Array(neuralData) })

// Streaming mode — send chunks then signal end
await model.append({ type: 'neural', input: chunk1 })
await model.append({ type: 'neural', input: chunk2 })
await model.append({ type: 'end of job' })

await model.destroyInstance()
```

## Testing

### Integration Tests

```bash
WHISPER_MODEL_PATH=./models/ggml-bci-windowed.bin npm run test:integration
```

### C++ Unit Tests

```bash
VCPKG_ROOT=/path/to/vcpkg npm run test:cpp
```

## Configuration

### whisperConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `language` | string | `"en"` | Language code |
| `temperature` | number | `0.0` | Sampling temperature |
| `n_threads` | number | `0` (auto) | Number of threads |

### bciConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `day_idx` | number | `0` | Session day index for day-specific projection |

### contextParams

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | **Required.** Path to BCI GGML model file |
| `use_gpu` | boolean | Enable GPU acceleration |
| `flash_attn` | boolean | Enable flash attention |

## whisper.cpp Patches

The BCI patches live in the `tetherto/qvac-ext-lib-whisper.cpp` fork (v1.8.4.2) and are consumed via the `qvac-registry-vcpkg` port:

| Feature | Description |
|---------|-------------|
| Variable conv1 kernel | Read `n_audio_conv1_kernel` from model header (k=7 for 512ch BCI vs k=3 for audio) |
| Windowed attention | Attention mask with configurable window size/layer params in header |
| BCI SOS tokens | BCI-specific start-of-sequence token handling |
| Graph placement fix | Correct encoder-graph mask population for the encoder graph refactor |

## Platform Support

| Platform | Architecture | Status |
|----------|-------------|--------|
| macOS | arm64 (Apple Silicon) | Tested |
| Linux | x64 | Feasible (same build system as transcription-whispercpp) |
| Windows | x64 | Feasible (whisper.cpp supports MSVC) |
| Android | arm64 | Feasible (NDK toolchain) |
| iOS | arm64 | Feasible (Xcode toolchain) |

## License

Apache-2.0
