# Bergamot Translator Integration

This document describes the integration of Bergamot translator into the quality evaluation framework.

## Overview

Bergamot translator has been added as a new backend option alongside QVAC, OpusMT, Google Translate, and NLLB. It uses the `bergamot-translator` Python package for local neural machine translation with **Firefox Translations Models** from Mozilla.

## Requirements

- **Python 3.10 or earlier**: The bergamot package only supports Python 3.6-3.10 (pre-built wheels)
- **bergamot package**: Installed via `pip install bergamot`

## Implementation Details

### Files Modified

1. **benchmarks/quality_eval/translators/bergamot_translator.py**
   - New translator backend implementation
   - Handles model downloading and configuration
   - Supports both direct and pivot translation

2. **benchmarks/quality_eval/evaluate.py**
   - Added bergamot to `SUPPORTED_PAIRS` dictionary
   - Added command mapping for bergamot translator (line 221)

3. **benchmarks/quality_eval/requirements.txt**
   - Added `bergamot` dependency

4. **.github/workflows/benchmark.yaml**
   - Updated translator options description to include bergamot (line 12)

### How It Works

The bergamot translator:

1. **Model Management**: Uses Firefox Translations models downloaded via git-lfs
   - Models are stored in `~/.local/share/bergamot/models/firefox/base-memory/`
   - Automatically creates bergamot config files with optimized parameters
   - Uses base-memory architecture (optimized for speed and quality)

2. **Translation Modes**:
   - **Direct translation**: Translates directly from source to target language
   - **Pivot translation**: Translates via English for non-English pairs (src→en→trg)

3. **Batch Processing**: Processes translations in batches of 10 sentences for efficiency

### Known Limitations

1. **Python Version**: Requires Python 3.10 or earlier due to bergamot package constraints

2. **Language Pair Availability**: Only language pairs available in Firefox Translations models are supported
   - Check https://github.com/mozilla/firefox-translations-models for available pairs
   - The workflow downloads models automatically for requested pairs

3. **Model Size**: Base-memory models are ~30MB each (optimized but still require disk space)

## Firefox Translations Models

High-quality base-memory models from Mozilla's Firefox Translations project:
- **Source**: https://github.com/mozilla/firefox-translations-models
- **Quality**: Optimized for production use in Firefox browser
- **Architecture**: base-memory (optimized for speed and memory efficiency)
- **Italian support**: ✅ en-it, it-en
- **Other languages**: Many European languages including de, es, fr, cs, pl, and more

The workflow automatically downloads Firefox models using git-lfs when needed.

Firefox models are stored in `~/.local/share/bergamot/models/firefox/base-memory/`

Each model directory contains:
- `model.{pair}.intgemm.alphas.bin` - Quantized translation model
- `vocab.{pair}.spm` - SentencePiece vocabulary
- `lex.50.50.{pair}.s2t.bin` - Lexical shortlist
- `metadata.json` - Model metadata and quality scores

## Usage

### Command Line

```bash
# Evaluate with bergamot (Italian)
python evaluate.py --pairs en-it --translators bergamot

# Compare bergamot with other translators
python evaluate.py --pairs en-it --translators qvac,opusmt,bergamot

# Multiple language pairs
python evaluate.py --pairs en-it,en-de,de-en --translators bergamot

# Use pivot translation for non-English pairs
python evaluate.py --pairs de-fr --translators bergamot --use-pivot
```

### GitHub Actions Workflow

```yaml
# In workflow dispatch inputs:
translators: 'bergamot'
pairs: 'en-it'  # Italian - main use case
# or
pairs: 'en-it,en-de,de-en'  # Multiple pairs
use_pivot: true  # Enable pivot for non-English pairs
```

## Testing

To test the bergamot translator locally with Firefox models:

```bash
cd benchmarks/quality_eval

# First, set up Firefox models (if not already done by workflow)
# FIREFOX_MODELS_DIR=/path/to/firefox-translations-models/models

# Test en-it
echo "Hello, how are you?" | SRC=en TRG=it python3.10 translators/bergamot_translator.py
```

Expected output:
```
Using Firefox translations model: en-it
Ciao, come stai?
```

Test German:
```bash
echo "Hello, how are you?" | SRC=en TRG=de python3.10 translators/bergamot_translator.py
```

Expected output:
```
Using Firefox translations model: en-de
Hallo, wie geht es dir?
```

## Configuration Parameters

The bergamot translator uses the following configuration aligned with bergamot-translator defaults:

- **beam-size**: 1 (greedy decoding for speed)
- **max-length-break**: 128 tokens
- **mini-batch-words**: 1024 words
- **workspace**: 128 MB
- **alignment**: soft (for quality estimation)
- **normalize**: 1.0
- **word-penalty**: 0

These parameters match the official bergamot-translator Python bindings configuration.

## Performance Notes

- **Model Size**: Base models are ~40MB, tiny models are smaller
- **Translation Speed**: Depends on CPU, typically processes 3-5 batches/second
- **Memory**: Requires ~128MB workspace for translation (configurable)

## Troubleshooting

### Import Error
If you see import errors for bergamot:
- Ensure you're using Python 3.10 or earlier
- Reinstall: `python3.10 -m pip install --force-reinstall bergamot>=0.4.5`

### Model Not Found Errors
If you see "Firefox translations model not found for {pair}":
- Check that the workflow downloaded the models (check workflow logs)
- Verify the language pair exists in Firefox Translations models
- Check models directory: `ls ~/.local/share/bergamot/models/firefox/base-memory/`
- For local testing, ensure FIREFOX_MODELS_DIR points to the correct location

### Translation Returns Empty Results
- Check that all model files exist in the model directory:
  - `model.{pair}.intgemm.alphas.bin`
  - `vocab.{pair}.spm`
  - `lex.50.50.{pair}.s2t.bin`
- Check stderr output for specific error messages
- Verify git-lfs pulled the actual files (not just pointers)
