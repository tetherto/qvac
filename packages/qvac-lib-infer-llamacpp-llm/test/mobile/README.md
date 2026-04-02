# Mobile Testing for LLM Llamacpp

This directory contains the mobile test configuration for the `@qvac/llm-llamacpp` addon.

> ⚠️ **Note**: This test directory is included in the published npm package to support the mobile testing framework. These test files are NOT part of the public API and should only be used by the internal mobile testing infrastructure.

## Test Structure

- `test.cjs` - Main test file with `startTest()` function that runs automatically on mobile
- `testAssets/` - Directory for model files and test data

## Setup

### Download Test Model

The test requires a small GGUF model file. Download it to the `testAssets` directory:

```bash
cd test/mobile/testAssets

# Download a small test model (~500KB)
curl -L -o small-test-model.gguf \
  https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf
```

### Verify Setup

```bash
ls -lh testAssets/
# Should show: small-test-model.gguf (~500KB)
```

## What the Test Does

The mobile test performs a complete LLM inference workflow:

1. **Initialize Filesystem Loader** - Sets up file access for the model
2. **Configure Model** - Uses GPU-accelerated settings (99 GPU layers) for faster inference
3. **Load Model** - Loads the GGUF model weights into memory and offloads to GPU
4. **Run Inference** - Generates text from the prompt "Say hello in one word"
5. **Cleanup** - Properly destroys the model instance and closes the loader

## Running the Test

From the mobile tester app root:

```bash
# Build the test app with llm-llamacpp
npm run build ../qvac-lib-infer-llamacpp-llm

# Run on Android
npm run android

# Run on iOS
npm run ios
```

The app will:
- Automatically initialize after 3 seconds
- Start the test after 5 seconds
- Display progress and results on screen

## Expected Output

Success message will show:
```
TEST COMPLETE ✓

Model loaded and generated X characters in response to: "Say hello in one word."

Generated: Hello
```

## Troubleshooting

### Model file not found
- Ensure `small-test-model.gguf` is in the `testAssets/` directory
- Check that the file downloaded completely (~500KB)

### Out of memory
- The test uses a very small model (~500KB)
- If issues persist, try closing other apps

### Timeout errors
- The test waits up to 60 seconds for generation
- On slower devices, this may need to be increased in `test.cjs`

## Model Details

**Model**: TinyLlamas Stories 260K
- Size: ~500KB
- Format: GGUF
- Purpose: Fast mobile testing
- Source: https://huggingface.co/ggml-org/models

This is an extremely small model designed for quick testing, not production use.
