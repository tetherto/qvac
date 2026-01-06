# Translation Quality Evaluation Framework

A modular framework for evaluating translation quality using BLEU scores on Flores datasets. Supports multiple translation systems including QVAC, OpusMT, Google Translate, and NLLB.

## Overview

This framework provides:
- **BLEU score evaluation** using sacrebleu on standard Flores datasets
- **Modular architecture** - easily add new translators
- **Multiple backends** - QVAC, OpusMT, Google Translate, NLLB
- **Automatic dataset management** - downloads Flores datasets as needed
- **Parallel evaluation** - evaluate multiple language pairs and translators

## Installation

1. Install Python dependencies:

```bash
pip install -r requirements.txt
```

2. For QVAC translator:
   - Ensure the QVAC addon is built and available in the prebuilds directory
   - Requires Bare runtime to be installed

3. For Google Translate:
   - Set the `GOOGLE_API_KEY` environment variable with your API key

## Usage

### Basic Examples

Evaluate QVAC vs OpusMT on English to Italian:

```bash
python evaluate.py --pairs en-it --translators qvac,opusmt
```

Evaluate multiple pairs:

```bash
python evaluate.py --pairs en-it,en-de,de-en --translators qvac,opusmt,nllb
```

Use Flores-dev dataset (instead of default flores-devtest):

```bash
python evaluate.py --pairs en-it --dataset flores-dev
```

Include all translators:

```bash
python evaluate.py --pairs en-it,en-de --translators qvac,opusmt,google,nllb
```

### Command-Line Options

- `--pairs` (required): Comma-separated language pairs (e.g., 'en-it,en-de')
- `--translators` (default: qvac,opusmt): Comma-separated translator list
- `--dataset` (default: flores-devtest): Choose 'flores-dev' or 'flores-devtest'
- `--results-dir` (default: ./results): Directory to store results
- `--data-dir` (default: ./data): Directory for Flores datasets
- `--skip-existing/--no-skip-existing` (default: True): Skip already evaluated pairs

## Supported Language Pairs

### QVAC
- en ↔ de, es, it
- de ↔ es, it
- es ↔ it

### OpusMT
- en ↔ de, es, it, fr

### Google Translate
- Supports most language pairs

### NLLB
- Supports 200+ languages

## Output Structure

Results are stored in the following structure:

```
results/
├── en-it/
│   ├── flores-devtest.en          # Source text
│   ├── flores-devtest.it          # Reference translation
│   ├── flores-devtest.qvac.it     # QVAC translation
│   ├── flores-devtest.qvac.it.bleu   # BLEU score (e.g., "28.5")
│   ├── flores-devtest.opusmt.it
│   └── flores-devtest.opusmt.it.bleu
└── en-de/
    └── ...
```

## Adding New Translators

To add a new translator:

1. Create a new script in `translators/` directory (e.g., `translators/mytranslator.py`)

2. Implement the translator interface:

```python
#!/usr/bin/env python3
import os
import sys

def translate(texts):
    """
    Translate a list of texts.

    Args:
        texts: List of source text strings

    Returns:
        List of translated strings
    """
    source = os.environ["SRC"]
    target = os.environ["TRG"]

    # Your translation logic here
    translations = []
    for text in texts:
        translation = your_translate_function(text, source, target)
        translations.append(translation)

    return translations

if __name__ == "__main__":
    texts = [line.strip() for line in sys.stdin]
    translations = translate(texts)
    for translation in translations:
        print(translation)
```

3. Update `SUPPORTED_PAIRS` in `evaluate.py` if your translator has limited language support:

```python
SUPPORTED_PAIRS = {
    "mytranslator": {
        ("en", "de"), ("en", "es"), ...
    }
}
```

4. Add the translator to the command mapping in `translate_file()`:

```python
if translator == "mytranslator":
    cmd = ["python3", str(script_dir / "mytranslator.py")]
```

5. Run evaluation:

```bash
python evaluate.py --pairs en-it --translators mytranslator,qvac
```

## Flores Datasets

The framework supports two Flores datasets:

- **flores-dev** (flores101): 1012 sentences, dev split
- **flores-devtest** (flores200): 1012 sentences, devtest split

Datasets are automatically downloaded to the `data/` directory on first use.

## Notes

- BLEU scores are calculated using sacrebleu with default settings
- The framework uses standard Flores language codes (e.g., eng_Latn, deu_Latn)
- Results are cached by default - use `--no-skip-existing` to re-evaluate
- QVAC requires models to be available in `qvac_models/{src}-{trg}/model.bin`
- OpusMT downloads models from Helsinki-NLP on Hugging Face
- NLLB uses the facebook/nllb-200-distilled-600M model

## Troubleshooting

### QVAC not working
- Verify the addon is built: `ls prebuilds/linux-x64/*.bare`
- Check model files exist: `ls qvac_models/*/model.bin`
- Ensure Bare runtime is installed

### OpusMT model not found
- Check if the language pair is available on Helsinki-NLP
- Verify PyTorch and transformers are installed correctly

### Google Translate errors
- Verify `GOOGLE_API_KEY` environment variable is set
- Check API quota and billing status

### NLLB language not supported
- Check FLORES_NLLB_CODE in translators/nllb.py for supported codes
- Some languages may need custom code mapping
