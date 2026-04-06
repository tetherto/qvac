# Unit Test Models

This directory contains NMT models required for C++ unit tests.

## Required Models

| Model | Size | Purpose |
|-------|------|---------|
| `ggml-indictrans2-en-indic-dist-200M-q4_0.bin` | ~122M | English → Indic (IndicTrans tests) |

## Setup Options

### Option 1: Using HyperdriveDL (Recommended - No AWS Needed)

Run the JS examples to download models via peer-to-peer network, then create symlinks:

```bash
# Step 1: Download models by running examples
bare examples/indictrans.js          # Downloads IndicTrans model

# Step 2: Create symlinks for C++ tests
mkdir -p models/unit-test
ln -sf ../ggml-indictrans2-en-indic-dist-200M.bin models/unit-test/ggml-indictrans2-en-indic-dist-200M-q4_0.bin

# Step 3: Run tests
./build/addon/tests/addon-test
```

### Option 2: Using AWS S3 (Requires AWS Access)

```bash
# Download from S3 (requires AWS credentials)
aws s3 cp s3://${MODEL_S3_BUCKET}/qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-en-indic-dist-200M/2026-01-01/ggml-indictrans2-en-indic-dist-200M-q4_0.bin models/unit-test/
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

In CI/CD pipelines, models are automatically downloaded from S3 before running tests.
See `.github/workflows/cpp-tests.yaml` for the automated configuration.

## Verifying Setup

```bash
ls -la models/unit-test/
```

You should see `.bin` files (or symlinks pointing to `../model.bin` etc.).
