# Mobile Testing for Stable Diffusion

This directory contains the mobile test configuration for the `@qvac/diffusion-cpp` addon.

> **Note**: This test directory is included in the published npm package to support the mobile testing framework. These test files are NOT part of the public API and should only be used by the internal mobile testing infrastructure.

## Test Structure

- `integration-runtime.cjs` - Shared runtime that provides `runIntegrationModule` global
- `integration.auto.cjs` - Auto-generated wrappers for each integration test
- `testAssets/` - Directory for model files and test data

## Setup

### Download Test Model

The test requires a Stable Diffusion model file. Download it to the `testAssets` directory:

```bash
cd test/mobile/testAssets

# Download a quantized SD model
curl -L -o sd-v1-4-Q4_0.gguf <model-url>
```

## Running the Test

From the mobile tester app root:

```bash
# Build the test app with diffusion-cpp
npm run build ../diffusion-cpp

# Run on Android
npm run android

# Run on iOS
npm run ios
```

## Regenerating Tests

After adding or removing integration test files:

```bash
npm run test:mobile:generate
```

To validate that auto-generated tests are in sync:

```bash
npm run test:mobile:validate
```

## Troubleshooting

### Model file not found
- Ensure the model file is in the `testAssets/` directory
- Check that the file downloaded completely

### Out of memory
- SD models are larger than LLM models; use quantized (Q4) variants for testing
- Close other apps to free memory

### Timeout errors
- Image generation can be slow on mobile devices
- The test waits up to 600 seconds for generation
