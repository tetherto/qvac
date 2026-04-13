# @qvac/bci-whispercpp

Brain-Computer Interface (BCI) neural signal transcription addon for qvac, powered by [whisper.cpp](https://github.com/tetherto/whisper.cpp).

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

| Sample | Ground Truth | GGML Native Output | Python Reference |
|--------|-------------|-------------------|-----------------|
| 0 | "You can see the code at this point as well." | "You can see the good at this point as well." | "you can see the good at this point as well" |
| 1 | "How does it keep the cost down?" | "How does it keep the cost said?" | "how does it keep the cost said" |
| 2 | "Not too controversial." | "Not too controversial." | "not too controversial" |
| 3 | "The jury and a judge work together on it." | "The jury and a judge work together on it." | "the jury and a judge work together on it" |
| 4 | "Were quite vocal about it." | "We're quite vocal about it." | "we're quite vocal about it" |

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

- **Bare runtime** >= 1.19.0
- **CMake** >= 3.25
- **vcpkg** with `VCPKG_ROOT` environment variable set

### Model Conversion

Convert a trained BrainWhisperer checkpoint to GGML format:

```bash
python3 scripts/convert-model.py \
  --checkpoint /path/to/epoch=93-val_wer=0.0910.ckpt \
  --output models/ggml-bci.bin \
  --day-idx 1 \
  --window-size 57 \
  --last-window-layer 3
```

The converter merges LoRA weights, extracts the BCI encoder (conv1 k=7, 6 transformer layers), and writes the GGML model with BCI-specific header fields (`n_audio_conv1_kernel`, `n_audio_window_size`, `n_audio_last_window_layer`).

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
  if (event === 'Output') console.log('Segment:', data.text)
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
WHISPER_MODEL_PATH=./models/ggml-bci.bin npm run test:integration
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

The package includes a vcpkg overlay with 4 patches applied to whisper.cpp:

| Patch | Description |
|-------|-------------|
| 0001 | Fix vcpkg build |
| 0002 | Fix Apple Silicon cross-compilation |
| 0003 | Variable conv1 kernel size (read `n_audio_conv1_kernel` from model header) |
| 0004 | Windowed attention mask, window size/layer params in header, BCI-specific SOS tokens |

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
