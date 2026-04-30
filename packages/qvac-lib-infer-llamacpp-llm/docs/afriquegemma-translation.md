# AfriqueGemma Translation — Setup, Configuration & Supported Languages

**Package:** `@qvac/llm-llamacpp`  
**Model:** [McGill-NLP/AfriqueGemma-4B](https://huggingface.co/McGill-NLP/AfriqueGemma-4B)  
**GGUF source:** [mradermacher/AfriqueGemma-4B-GGUF](https://huggingface.co/mradermacher/AfriqueGemma-4B-GGUF)  
**Last Updated:** 2026-03-06

---

## Table of Contents

- [Overview](#overview)
- [Supported Languages](#supported-languages)
- [Model Variants & Quantizations](#model-variants--quantizations)
- [Configuration](#configuration)
  - [Addon Config Parameters](#addon-config-parameters)
  - [Chat Template (Jinja)](#chat-template-jinja)
  - [Prompt Format](#prompt-format)
- [Setup](#setup)
  - [Download the Model](#download-the-model)
  - [Bare Runtime (Addon)](#bare-runtime-addon)
  - [Python Validation (Transformers)](#python-validation-transformers)
- [Integration Tests](#integration-tests)
- [Deployment Notes](#deployment-notes)
- [Resource Requirements](#resource-requirements)
- [Known Limitations](#known-limitations)

---

## Overview

AfriqueGemma-4B is a **base language model** (not instruction-tuned) built on the Gemma 2 architecture and specialized for African languages. It supports translation, text completion, and language understanding across 20+ African languages plus English, French, Portuguese, and Arabic.

Because it is a base model, it responds best to **completion-style prompts** rather than instruction-style prompts. The model continues a pattern rather than following an instruction.

---

## Supported Languages

AfriqueGemma-4B covers **24 languages** spanning 4 language families across Africa:

### Niger-Congo Family

| Language | ISO 639-1 | Region |
|----------|-----------|--------|
| Swahili | sw | East Africa |
| Yoruba | yo | West Africa |
| Hausa | ha | West Africa |
| Zulu | zu | Southern Africa |
| Igbo | ig | West Africa |
| Shona | sn | Southern Africa |
| Twi (Akan) | tw | West Africa |
| Lingala | ln | Central Africa |
| Kinyarwanda | rw | East Africa |
| Chichewa (Nyanja) | ny | Southern Africa |
| Luganda | lg | East Africa |
| Wolof | wo | West Africa |
| Fon | — | West Africa |
| Ewe | ee | West Africa |
| Bambara | bm | West Africa |
| Kikuyu | ki | East Africa |
| Luo | — | East Africa |
| Tswana | tn | Southern Africa |
| Sotho | st | Southern Africa |
| Xhosa | xh | Southern Africa |

### Afro-Asiatic Family

| Language | ISO 639-1 | Region |
|----------|-----------|--------|
| Arabic | ar | North Africa / Middle East |

### High-Resource Languages

| Language | ISO 639-1 | Notes |
|----------|-----------|-------|
| English | en | Primary source/target |
| French | fr | Widely spoken in West/Central Africa |
| Portuguese | pt | Spoken in Mozambique, Angola, Guinea-Bissau |

### Translation Pairs

The model performs best on these directions:

- **En ↔ Swahili, Yoruba, Hausa, Zulu** — strongest coverage
- **Fr ↔ African languages** — strong for Francophone Africa
- **African ↔ English** — reverse translation also supported
- **African ↔ African** — possible but less reliable, use English as pivot

---

## Model Variants & Quantizations

Available GGUF quantizations from `mradermacher/AfriqueGemma-4B-GGUF`:

| Quantization | Size | Quality | Recommended Use |
|-------------|------|---------|-----------------|
| `f16` | ~8.5 GB | Reference | Validation, oracle comparison |
| `Q8_0` | ~4.6 GB | Near-lossless | High-quality inference |
| `Q6_K` | ~3.5 GB | Excellent | Production (high quality) |
| `Q5_K_M` | ~3.1 GB | Very good | Production (balanced) |
| `Q5_0` | ~3.1 GB | Good | Production |
| **`Q4_K_M`** | **~2.7 GB** | **Good** | **Recommended default** |
| `Q4_0` | ~2.6 GB | Acceptable | Memory-constrained |

**Recommendation:** Use `Q4_K_M` for the best balance of quality and memory. Use `Q8_0` or `f16` when accuracy is critical.

---

## Configuration

### Addon Config Parameters

When loading AfriqueGemma via `LlmLlamacpp`:

```javascript
const config = {
  device: 'cpu',          // 'cpu' or 'gpu'
  gpu_layers: '0',        // '999' for full GPU offload, '0' for CPU-only
  ctx_size: '2048',       // Context window (tokens). 2048 is sufficient for translation
  temp: '0',              // Temperature. 0 = greedy/deterministic
  top_p: '1',             // Nucleus sampling. 1 = disabled (greedy)
  top_k: '1',             // Top-k sampling. 1 = disabled (greedy)
  n_predict: '64',        // Max tokens to generate per request
  repeat_penalty: '1',    // Repetition penalty. 1 = no penalty
  seed: '42',             // Random seed for reproducibility
  tools: 'true',          // REQUIRED: enables Jinja chat template parsing
  verbosity: '1'          // Log level (0=silent, 1=info, 2=verbose, 3=debug)
}
```

### Chat Template (Jinja)

AfriqueGemma uses a **custom Gemma-style chat template** with Jinja syntax. The `tools: 'true'` config parameter is **required** — it enables Jinja template rendering in the underlying llama.cpp engine. Without it, model loading fails with:

```
Fatal error: this custom template is not supported, try using --jinja
```

This is a non-obvious requirement: `tools` refers to the llama.cpp `--jinja` flag, not tool-calling functionality.

### Prompt Format

AfriqueGemma is a **base model** (not instruction-tuned). For translation, use completion-style prompts:

```
Translate English to Swahili.
English: The weather is beautiful today.
Swahili:
```

The model completes the pattern and produces the translation on the next line. To extract only the translation, stop generation at the first newline character (`\n`).

**Prompt template:**
```
Translate {source_lang} to {target_lang}.
{source_lang}: {source_text}
{target_lang}:
```

**Important:** The addon wraps prompts in the chat template (`<start_of_turn>user\n...<end_of_turn>\n<start_of_turn>model\n`). When comparing with HuggingFace Transformers, apply `tokenizer.apply_chat_template()` on the Transformers side for a fair comparison.

---

## Setup

### Download the Model

**Option A: Via HuggingFace Hub (Python)**

```bash
pip install huggingface_hub
python -c "
from huggingface_hub import hf_hub_download
hf_hub_download(
    repo_id='mradermacher/AfriqueGemma-4B-GGUF',
    filename='AfriqueGemma-4B.Q4_K_M.gguf',
    local_dir='~/.qvac/models'
)
"
```

**Option B: Direct download**

```bash
mkdir -p ~/.qvac/models
wget -O ~/.qvac/models/AfriqueGemma-4B-Q4_K_M.gguf \
  "https://huggingface.co/mradermacher/AfriqueGemma-4B-GGUF/resolve/main/AfriqueGemma-4B.Q4_K_M.gguf"
```

### Bare Runtime (Addon)

```javascript
const LlmLlamacpp = require('@qvac/llm-llamacpp')
const path = require('bare-path')

const modelDir = '/path/to/models'

const model = new LlmLlamacpp({
  files: {
    model: [path.join(modelDir, 'AfriqueGemma-4B-Q4_K_M.gguf')]
  },
  config: {
    device: 'cpu',
    ctx_size: '2048',
    temp: '0',
    top_k: '1',
    top_p: '1',
    n_predict: '64',
    seed: '42',
    tools: 'true'
  },
  logger: console
})

await model.load()

const messages = [{
  role: 'user',
  content: 'Translate English to Swahili.\nEnglish: Hello, how are you?\nSwahili:'
}]

const response = await model.run(messages)
let translation = ''
await response
  .onUpdate(data => { translation += data })
  .await()

// Extract first line only (the translation)
translation = translation.split('\n')[0].trim()
console.log(translation)

await model.unload()
```

### Python Validation (Transformers)

The `validate_gguf_oracle.py` script compares the addon output against HuggingFace Transformers:

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/client
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Token comparison (addon vs Transformers)
python validate_gguf_oracle.py \
  --gguf-model "mradermacher/AfriqueGemma-4B-GGUF:Q4_K_M" \
  --transformers-model "McGill-NLP/AfriqueGemma-4B" \
  --compare token

# Logits comparison (llama-cpp-python vs Transformers)
python validate_gguf_oracle.py \
  --gguf-model "mradermacher/AfriqueGemma-4B-GGUF:Q4_K_M" \
  --transformers-model "McGill-NLP/AfriqueGemma-4B" \
  --compare logits

# Both (default)
python validate_gguf_oracle.py \
  --gguf-model "mradermacher/AfriqueGemma-4B-GGUF:Q4_K_M" \
  --transformers-model "McGill-NLP/AfriqueGemma-4B" \
  --compare token,logits
```

---

## Integration Tests

Test file: `test/integration/afriquegemma-translation.test.js`

Run with:
```bash
npm run test:integration:generate
bare test/integration/afriquegemma-translation.test.js --exit
```

**Prerequisites:** AfriqueGemma GGUF must be available locally (either in `test/model/` or `~/.qvac/models/`). Tests are skipped if the model is absent.

### Test Coverage

| Test | What it validates |
|------|------------------|
| Model loads and generates | Basic model loading with AfriqueGemma config (incl. `tools: 'true'`) |
| En → African languages | English to Swahili, Yoruba, Hausa, Zulu translation output |
| African/French → English | Reverse translation for Swahili and French |
| Language routing | All 6 language pairs in sequence, verifying routing and distinct outputs |
| Deterministic output | Greedy decoding (`temp=0`) produces identical results on repeated runs |
| Chat template config | `tools: 'true'` enables Jinja template without error |

---

## Deployment Notes

### Memory Requirements

| Quantization | Model RAM | Runtime Overhead | Total (min) |
|-------------|-----------|-----------------|-------------|
| Q4_K_M | ~2.7 GB | ~0.5 GB | **~3.2 GB** |
| Q8_0 | ~4.6 GB | ~0.5 GB | ~5.1 GB |
| f16 | ~8.5 GB | ~1.0 GB | ~9.5 GB |

Context window size adds to memory usage: ~2 MB per 1024 tokens of context.

### CPU vs GPU

- **CPU (x86-64):** Requires AVX2 + FMA for acceptable performance. AVX-512 provides ~20% speedup.
- **CPU (ARM64):** Requires NEON. Apple Silicon (M-series) performs well; Linux ARM64 (Graviton) is supported but slower.
- **GPU (Vulkan):** The addon uses Vulkan (not CUDA). Set `device: 'gpu'`, `gpu_layers: '999'` for full offload.
- **GPU (Metal):** Automatic on macOS/iOS with `device: 'gpu'`.

### Context Size

For translation tasks, `ctx_size: '2048'` is sufficient. The completion-style prompts are short (~20-30 tokens). Increase to `4096` or `8192` for longer documents or few-shot prompting.

### Stop Sequence

The model generates text beyond the first translation line. Use one of:
- **Addon:** Cancel inference on first `\n` in streamed output
- **llama-cli:** `--reverse-prompt $'\n'`
- **Python Transformers:** Set newline token as additional `eos_token_id`

### Production Considerations

1. **Model path:** Store GGUF in a persistent volume. Models are passed to `LlmLlamacpp` as absolute paths via `files.model` (an array of one or more GGUF file paths).
2. **Warm-up:** First inference after load is slower due to KV cache initialization. Run a dummy prompt after `model.load()`.
3. **Concurrency:** `LlmLlamacpp` supports one active inference at a time. Queue requests at the application layer.
4. **Error handling:** Wrap `model.run()` in try/catch. The addon throws on context overflow or busy state.

---

## Resource Requirements

### Minimum VM Specification (CPU-only)

| Resource | Specification |
|----------|--------------|
| CPU | 4 vCPU (x86-64 with AVX2, or ARM64 with NEON) |
| RAM | 8 GB |
| Storage | 10 GB SSD |
| OS | Ubuntu 22.04+ / macOS 13+ |

### Recommended VM Specification (GPU)

| Resource | Specification |
|----------|--------------|
| CPU | 8 vCPU |
| RAM | 16 GB |
| GPU | 8 GB VRAM (Vulkan-compatible) |
| Storage | 20 GB SSD |
| OS | Ubuntu 22.04+ with Vulkan drivers |

---

## Known Limitations

1. **Base model behavior:** AfriqueGemma-4B is not instruction-tuned. It will not follow instructions like "Translate this." It requires completion-style prompts with clear patterns.

2. **Repetitive output:** Without a stop sequence, the model repeats the translation pattern indefinitely. Always implement newline-based stopping.

3. **Low-resource languages:** Translation quality varies significantly. Swahili, Yoruba, Hausa, and Zulu have the best coverage. Languages like Fon, Ewe, or Luo may produce lower-quality or mixed-language output.

4. **Quantization drift:** Q4_K_M introduces minor differences vs. the full-precision model. Word-level overlap is typically >70%; exact token match is rare. Use the validation script to measure drift for your use case.

5. **Chat template requirement:** The `tools: 'true'` config is required for AfriqueGemma's Jinja template. This is easy to miss and produces a confusing error message about "custom template not supported."
