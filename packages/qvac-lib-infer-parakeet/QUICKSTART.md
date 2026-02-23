# Quick Start Guide

Get started with qvac-lib-infer-parakeet in 5 minutes!

## 1. Build the Addon

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/qvac-lib-infer-parakeet

# Install dependencies and build
npm install
```

That's it! `npm install` will automatically build the addon using bare-make.

## 2. Download a Model

```bash
npm run download-models
```

Choose option 1 (TDT - Multilingual) for best results.

## 3. Create Your First Transcription

Create `transcribe.js`:

```javascript
const parakeet = require('qvac-lib-infer-parakeet')

// Create instance
const handle = parakeet.createInstance(
  {
    modelPath: './models/parakeet-tdt-0.6b-v3-onnx',
    modelType: 'tdt',
    config: {
      language: 'auto',
      maxThreads: 4,
      useGPU: false
    }
  },
  (handle, event, data, error) => {
    if (error) {
      console.error('Error:', error)
      return
    }
    
    if (event === 'transcription') {
      console.log('Result:', data.text)
    }
  }
)

// Load model (simplified - see examples for full version)
parakeet.activate(handle)

// Transcribe audio
parakeet.runJob(handle, {
  type: 'audio',
  data: audioBuffer,  // Float32Array buffer
  sampleRate: 16000,
  channels: 1
})

// Cleanup
parakeet.destroyInstance(handle)
```

## 4. Run

```bash
bare transcribe.js
```

## Transcribe Other Languages

Use the flexible `transcribe.js` script for multilingual transcription:

```bash
# Transcribe French audio
bare examples/transcribe.js --file examples/samples/French.raw

# Transcribe Spanish audio  
bare examples/transcribe.js --file examples/samples/LastQuestion_long_ES.raw

# Use a different model (e.g., INT8 quantized)
bare examples/transcribe.js -f examples/samples/croatian.raw -m models/parakeet-tdt-0.6b-v3-onnx-int8-full
```

## Next Steps

- 📖 Read the [full documentation](README.md)
- 💻 Check out [examples](examples/)
- 🛠️ See [development guide](DEVELOPMENT.md)

## Getting Help

- 🐛 [Report issues](https://github.com/tetherto/qvac/issues)
- 💬 [Discussions](https://github.com/tetherto/qvac/discussions)

## Model Comparison

| Model | Languages | Speed | Use Case |
|-------|-----------|-------|----------|
| **TDT** ⭐ | ~25 | Medium | Best accuracy, multilingual |
| **CTC** | English only | Fast | English transcription |
| **EOU** | English | Fast | Real-time streaming |
| **Sortformer** | Any | Medium | Speaker identification |

⭐ = Recommended for most users

