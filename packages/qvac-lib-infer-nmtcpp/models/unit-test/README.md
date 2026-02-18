# Unit Test Models

This directory contains NMT models required for C++ unit tests.

## Required Models

| Model | Size | Purpose |
|-------|------|---------|
| `ggml-opus-en-it_q4_0.bin` | ~95M | English → Italian (GGML/Marian tests) |
| `ggml-opus-it-en_q4_0.bin` | ~96M | Italian → English (optional, skipped if missing) |
| `ggml-indictrans2-en-indic-dist-200M-q4_0.bin` | ~122M | English → Indic (IndicTrans tests) |

## Setup Options

### Option 1: Using HyperdriveDL (Recommended - No AWS Needed)

Run the JS examples to download models via peer-to-peer network, then create symlinks:

```bash
# Step 1: Download models by running examples
bare examples/quickstart.js          # Downloads model.bin (en→it)
bare examples/indictrans.js          # Downloads IndicTrans model (optional)

# Step 2: Create symlinks for C++ tests
mkdir -p models/unit-test
ln -sf ../model.bin models/unit-test/ggml-opus-en-it_q4_0.bin
ln -sf ../ggml-indictrans2-en-indic-dist-200M.bin models/unit-test/ggml-indictrans2-en-indic-dist-200M-q4_0.bin

# Step 3: Run tests
./build/addon/tests/addon-test
```

### Option 2: Using Download Script (Recommended for CI)

```bash
# Download all models via Hyperdrive (no AWS credentials needed)
bare scripts/download-models-hyperdrive.js --target cpp-tests
```

### Option 3: Run Only Tests That Don't Need Models

```bash
# Bergamot validation tests (no models needed)
./build/addon/tests/addon-test --gtest_filter="BergamotValidationTest.*:BergamotBatchTest.*:NmtConfigTest.*"
```

## What Happens If Models Are Missing?

- Tests that require missing models will be **skipped** with `GTEST_SKIP()`
- You'll see messages like: `Model not found: ... See models/unit-test/README.md for setup instructions.`
- Bergamot validation tests will still **run** (they don't need models)

## CI/CD

In CI/CD pipelines, models are automatically downloaded via Hyperdrive before running tests.
See `.github/workflows/reusable-cpp-tests-qvac-lib-infer-nmtcpp.yml` for the automated configuration.

## Verifying Setup

```bash
ls -la models/unit-test/
```

You should see `.bin` files (or symlinks pointing to `../model.bin` etc.).
