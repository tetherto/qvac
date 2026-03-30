# Translation Quality Evaluation Framework

A modular framework for evaluating translation quality using chrF++, BLEU, and COMET scores on Flores datasets. Supports multiple translation systems including QVAC NMT, AfriqueGemma LLM, OpusMT, Google Translate, NLLB, and Bergamot.

## Overview

This framework provides:
- **Multi-metric evaluation** using sacrebleu (BLEU, chrF++) and COMET on standard Flores datasets
- **Modular architecture** - easily add new translators
- **Multiple backends** - QVAC NMT, AfriqueGemma (LLM addon & llama-cpp-python), OpusMT, Google Translate, NLLB, Bergamot
- **Automatic dataset management** - downloads Flores datasets as needed
- **Parallel evaluation** - evaluate multiple language pairs and translators
- **Sample limiting** - run quick evaluations with `--max-samples`

## Installation

1. Install Python dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. For QVAC NMT translator:
   - Ensure the QVAC NMT addon is built and available in the prebuilds directory
   - Requires Bare runtime to be installed

3. For AfriqueGemma LLM translators:
   - **`afriquegemma_llm`** (QVAC LLM addon): Requires `bare` runtime and `@qvac/llm-llamacpp` addon (built locally or installed from npm). Model auto-downloads from HuggingFace if not present locally.
   - **`afriquegemma_llamacpp`** (llama-cpp-python): Requires `pip install llama-cpp-python`. Calls llama.cpp directly via Python bindings. Model auto-downloads from HuggingFace if not present locally.
   - Both look for the GGUF model in: `AFRIQUEGEMMA_GGUF_PATH` env var, then `~/.qvac/models/AfriqueGemma-4B*.gguf`, then auto-download from `mradermacher/AfriqueGemma-4B-GGUF`.

4. For Google Translate:
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

### AfriqueGemma Examples

Evaluate AfriqueGemma LLM addon on English-to-Swahili (30 samples, chrF++):

```bash
python evaluate.py --pairs en-sw --translators afriquegemma_llm --metrics chrfpp --max-samples 30
```

Compare QVAC addon vs llama-cpp-python backend:

```bash
python evaluate.py --pairs en-sw --translators afriquegemma_llm,afriquegemma_llamacpp --metrics chrfpp --max-samples 30
```

Evaluate multiple African language pairs:

```bash
python evaluate.py --pairs en-sw,en-yo,en-ha,sw-en --translators afriquegemma_llm --metrics chrfpp,comet
```

### Command-Line Options

- `--pairs` (required): Comma-separated language pairs (e.g., 'en-it,en-de')
- `--translators` (default: qvac,opusmt): Comma-separated translator list
- `--dataset` (default: flores-devtest): Choose 'flores-dev' or 'flores-devtest'
- `--metrics` (default: bleu): Comma-separated metric list (bleu, chrfpp, comet)
- `--max-samples` (default: 0 = all): Limit evaluation to first N samples
- `--results-dir` (default: ./results): Directory to store results
- `--data-dir` (default: ./data): Directory for Flores datasets
- `--skip-existing/--no-skip-existing` (default: True): Skip already evaluated pairs

## Supported Language Pairs

### QVAC (NMT)
- en ↔ de, es, it
- de ↔ es, it
- es ↔ it

### AfriqueGemma (`afriquegemma_llm` and `afriquegemma_llamacpp`)
- en ↔ sw, yo, ha, zu, am, ig, wo, sn, rw, lg, ts, tw, xh, ny, so, ln (African languages)
- en ↔ fr, pt, ar (high-resource languages)
- fr ↔ sw, yo, ha, wo (cross-lingual African via French)

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

## AfriqueGemma Translator Details

Two AfriqueGemma backends are available for comparison benchmarking:

| Translator | Backend | Dependencies | Use Case |
|------------|---------|-------------|----------|
| `afriquegemma_llm` | QVAC LLM addon via Bare runtime | `bare`, `@qvac/llm-llamacpp` | Production path (same addon used in apps) |
| `afriquegemma_llamacpp` | llama-cpp-python (direct ctypes) | `pip install llama-cpp-python` | Baseline comparison (raw llama.cpp) |

Both use identical prompt format, greedy decoding config (`temp=0, top_k=1, seed=42`), and `\n` stop sequence. Translation quality (chrF++) should be nearly identical; wall time differences reveal addon overhead.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AFRIQUEGEMMA_GGUF_PATH` | (auto-detect) | Override GGUF model path |
| `AFRIQUEGEMMA_MAX_TOKENS` | `256` | Max tokens per translation |
| `AFRIQUEGEMMA_HF_REPO` | `mradermacher/AfriqueGemma-4B-GGUF` | HuggingFace repo for auto-download |
| `AFRIQUEGEMMA_HF_FILE` | `AfriqueGemma-4B.Q4_K_M.gguf` | Filename in the HF repo |

### Model Resolution Order

1. `AFRIQUEGEMMA_GGUF_PATH` environment variable
2. `~/.qvac/models/AfriqueGemma-4B.Q4_K_M.gguf` or `AfriqueGemma-4B-Q4_K_M.gguf`
3. Auto-download from HuggingFace (requires network access)

### Using npm Package Instead of Local Build

The `afriquegemma_llm` translator uses `bare_infer.js` from the LLM addon's benchmark server. By default the server depends on a locally built addon (`"@qvac/llm-llamacpp": "file:../../"`). To use a published npm version instead, edit `packages/qvac-lib-infer-llamacpp-llm/benchmarks/server/package.json`:

```json
"@qvac/llm-llamacpp": "0.11.0"
```

Then run `npm install` in the `benchmarks/server/` directory. The published package includes prebuilds for all supported platforms.

## Notes

- Metrics are calculated using sacrebleu (BLEU, chrF++) and unbabel-comet (COMET)
- The framework uses standard Flores language codes (e.g., eng_Latn, deu_Latn, swh_Latn)
- Results are cached by default - use `--no-skip-existing` to re-evaluate
- QVAC NMT requires models to be available in `qvac_models/{src}-{trg}/model.bin`
- OpusMT downloads models from Helsinki-NLP on Hugging Face
- NLLB uses the facebook/nllb-200-distilled-600M model
- AfriqueGemma translators auto-download the GGUF model if not found locally
- LLM translators have a 6-hour timeout (vs 2 hours for conventional MT backends)

## Troubleshooting

### QVAC NMT not working
- Verify the addon is built: `ls prebuilds/linux-x64/*.bare`
- Check model files exist: `ls qvac_models/*/model.bin`
- Ensure Bare runtime is installed

### AfriqueGemma LLM addon not working
- Verify Bare is installed: `which bare`
- Check the addon is built or installed: `ls ../../qvac-lib-infer-llamacpp-llm/prebuilds/linux-x64/`
- Verify `bare_infer.js` exists: `ls ../../qvac-lib-infer-llamacpp-llm/benchmarks/server/bare_infer.js`
- Check model is available: `ls ~/.qvac/models/AfriqueGemma-4B*`
- After rebuilding the LLM addon, reinstall dependencies in the benchmark server so it picks up the new prebuilds:
  ```bash
  cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/server
  rm -rf node_modules
  npm install
  ```

### AfriqueGemma llama-cpp-python not working
- Verify llama-cpp-python is installed: `python3 -c "from llama_cpp import Llama; print('OK')"`
- If not installed: `pip install llama-cpp-python`
- Ensure you're running evaluate.py with the venv Python: `.venv/bin/python3 evaluate.py ...`

### OpusMT model not found
- Check if the language pair is available on Helsinki-NLP
- Verify PyTorch and transformers are installed correctly

### Google Translate errors
- Verify `GOOGLE_API_KEY` environment variable is set
- Check API quota and billing status

### NLLB language not supported
- Check FLORES_NLLB_CODE in translators/nllb.py for supported codes
- Some languages may need custom code mapping
