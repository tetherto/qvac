# Unit Test Models

This directory contains NMT models required for C++ unit tests.

## Models

The following GGML quantized models (q4_0) are used for testing:

- `ggml-indictrans2-en-indic-dist-200M-q4_0.bin` (122M) - English to Indic languages translation
- `ggml-opus-en-it_q4_0.bin` (95M) - English to Italian translation
- `ggml-opus-it-en_q4_0.bin` (96M) - Italian to English translation

## Downloading Models

### Using AWS CLI

To download the models for local testing, use the AWS CLI:

```bash
# Navigate to the project root
cd /path/to/qvac-lib-infer-nmtcpp

# Download all models
aws s3 cp s3://tether-ai-dev/qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-en-indic-dist-200M/2026-01-01/ggml-indictrans2-en-indic-dist-200M-q4_0.bin models/unit-test/
aws s3 cp s3://tether-ai-dev/qvac/tests/nmt/ggml-opus-en-it_q4_0.bin models/unit-test/
aws s3 cp s3://tether-ai-dev/qvac/tests/nmt/ggml-opus-it-en_q4_0.bin models/unit-test/
```

## Prerequisites

- AWS CLI installed and configured
- Appropriate AWS credentials with read access to S3

## CI/CD

In CI/CD pipelines, these models are automatically downloaded from S3 before running tests. See `.github/workflows/cpp-tests.yaml` for the automated download configuration.

## Verifying Downloads

After downloading, verify the models are present:

```bash
ls -lh models/unit-test/
```

You should see all three `.bin` files with the sizes listed above.
