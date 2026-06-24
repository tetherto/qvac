"""
AfriqueGemma translator using llama-cpp-python (direct llama.cpp bindings).

Bypasses the Bare runtime and QVAC LLM addon to call llama.cpp directly via
ctypes. Used for benchmarking the addon overhead vs raw llama.cpp performance.

The prompt format, greedy decoding config, and model resolution logic are
identical to afriquegemma_llm.py so that chrF++ scores can be compared
directly.

Environment variables:
  SRC               - source language code (e.g. "en")
  TRG               - target language code (e.g. "sw")
  AFRIQUEGEMMA_GGUF_PATH  - path to GGUF model (default: ~/.qvac/models/AfriqueGemma-4B-Q4_K_M.gguf)
  AFRIQUEGEMMA_MAX_TOKENS - max tokens per translation (default: 256)
  AFRIQUEGEMMA_HF_REPO    - HuggingFace repo for auto-download
  AFRIQUEGEMMA_HF_FILE    - filename inside the HF repo
"""

import os
import shutil
import sys
import time
from pathlib import Path

try:
    from llama_cpp import Llama
except ImportError:
    print(
        "[AfriqueGemma-llamacpp] ERROR: llama-cpp-python not installed.\n"
        "  pip install llama-cpp-python",
        file=sys.stderr,
    )
    sys.exit(1)

LANG_NAMES = {
    "en": "English",
    "fr": "French",
    "pt": "Portuguese",
    "ar": "Arabic",
    "sw": "Swahili",
    "yo": "Yoruba",
    "ha": "Hausa",
    "zu": "Zulu",
    "am": "Amharic",
    "ig": "Igbo",
    "wo": "Wolof",
    "sn": "Shona",
    "rw": "Kinyarwanda",
    "lg": "Luganda",
    "ts": "Tsonga",
    "tw": "Twi",
    "xh": "Xhosa",
    "ny": "Chichewa",
    "so": "Somali",
    "ln": "Lingala",
}

MODELS_DIR = Path.home() / ".qvac" / "models"

DEFAULT_GGUF_PATHS = [
    MODELS_DIR / "AfriqueGemma-4B.Q4_K_M.gguf",
    MODELS_DIR / "AfriqueGemma-4B-Q4_K_M.gguf",
]

HF_REPO_DEFAULT = "mradermacher/AfriqueGemma-4B-GGUF"
HF_FILE_DEFAULT = "AfriqueGemma-4B.Q4_K_M.gguf"


def download_from_huggingface(repo_id, filename, dest_dir):
    """Download a GGUF file from HuggingFace Hub to dest_dir."""
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / filename

    try:
        from huggingface_hub import hf_hub_download

        print(f"[AfriqueGemma-llamacpp] Downloading {filename} from hf://{repo_id} ...", file=sys.stderr)
        sys.stderr.flush()
        cached = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=str(dest_dir),
            local_dir_use_symlinks=False,
        )
        cached = Path(cached)
        if cached != dest_path and cached.exists():
            shutil.copy2(str(cached), str(dest_path))
        if dest_path.exists():
            size_mb = dest_path.stat().st_size / (1024 * 1024)
            print(f"[AfriqueGemma-llamacpp] Downloaded ({size_mb:.0f} MB) -> {dest_path}", file=sys.stderr)
            return str(dest_path)
    except ImportError:
        pass
    except Exception as e:
        print(f"[AfriqueGemma-llamacpp] HF download failed: {e}", file=sys.stderr)

    url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
    print(f"[AfriqueGemma-llamacpp] Downloading {url} ...", file=sys.stderr)
    sys.stderr.flush()
    try:
        from urllib.request import urlopen, Request

        req = Request(url, headers={"User-Agent": "qvac-eval/1.0"})
        with urlopen(req, timeout=600) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            with open(dest_path, "wb") as f:
                while True:
                    chunk = resp.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = downloaded * 100 // total
                        print(
                            f"\r[AfriqueGemma-llamacpp]   {pct}% ({downloaded // (1024*1024)} / {total // (1024*1024)} MB)",
                            end="", file=sys.stderr,
                        )
            print("", file=sys.stderr)

        if dest_path.exists() and dest_path.stat().st_size > 0:
            return str(dest_path)
    except Exception as e:
        print(f"[AfriqueGemma-llamacpp] Direct download failed: {e}", file=sys.stderr)
        if dest_path.exists():
            dest_path.unlink()

    return None


def resolve_gguf_path():
    """Resolve the GGUF model path from env, local defaults, or auto-download."""
    env_path = os.environ.get("AFRIQUEGEMMA_GGUF_PATH")
    if env_path:
        p = Path(env_path)
        if p.exists():
            return str(p)
        print(f"[AfriqueGemma-llamacpp] WARNING: AFRIQUEGEMMA_GGUF_PATH={env_path} not found", file=sys.stderr)

    for p in DEFAULT_GGUF_PATHS:
        if p.exists():
            return str(p)

    repo_id = os.environ.get("AFRIQUEGEMMA_HF_REPO", HF_REPO_DEFAULT)
    hf_file = os.environ.get("AFRIQUEGEMMA_HF_FILE", HF_FILE_DEFAULT)
    print(f"[AfriqueGemma-llamacpp] Model not found locally, downloading from {repo_id} ...", file=sys.stderr)

    downloaded = download_from_huggingface(repo_id, hf_file, str(MODELS_DIR))
    if downloaded:
        return downloaded

    print("[AfriqueGemma-llamacpp] ERROR: No GGUF model found and auto-download failed.", file=sys.stderr)
    sys.exit(1)


def build_prompt(src_lang, trg_lang, sentence):
    """Build a completion-style translation prompt (matches afriquegemma_llm.py)."""
    src_name = LANG_NAMES.get(src_lang, src_lang)
    trg_name = LANG_NAMES.get(trg_lang, trg_lang)
    return f"Translate {src_name} to {trg_name}.\n{src_name}: {sentence}\n{trg_name}:"


def translate(texts, src_lang, trg_lang):
    """Translate sentences using llama-cpp-python (direct llama.cpp bindings)."""
    gguf_path = resolve_gguf_path()
    max_tokens = int(os.environ.get("AFRIQUEGEMMA_MAX_TOKENS", "256"))

    print(f"[AfriqueGemma-llamacpp] Model: {gguf_path}", file=sys.stderr)
    print(f"[AfriqueGemma-llamacpp] Loading model ...", file=sys.stderr)
    sys.stderr.flush()

    load_start = time.time()
    llm = Llama(
        model_path=gguf_path,
        n_ctx=2048,
        seed=42,
        verbose=False,
    )
    load_elapsed = time.time() - load_start
    print(f"[AfriqueGemma-llamacpp] Model loaded in {load_elapsed:.1f}s", file=sys.stderr)
    print(f"[AfriqueGemma-llamacpp] Translating {len(texts)} sentences: {src_lang} -> {trg_lang}", file=sys.stderr)
    sys.stderr.flush()

    translations = []
    total_tokens = 0
    total_start = time.time()

    for i, text in enumerate(texts):
        prompt = build_prompt(src_lang, trg_lang, text)

        t0 = time.time()
        result = llm(
            prompt,
            temperature=0.0,
            top_k=1,
            max_tokens=max_tokens,
            stop=["\n"],
        )
        t1 = time.time()

        content = result["choices"][0]["text"].strip()
        usage = result.get("usage", {})
        gen_tokens = usage.get("completion_tokens", 0)
        total_tokens += gen_tokens

        elapsed_ms = (t1 - t0) * 1000
        tps = gen_tokens / (t1 - t0) if (t1 - t0) > 0 else 0

        translation = content.split("\n")[0].strip()
        translations.append(translation)

        print(
            f"[AfriqueGemma-llamacpp] [{i+1}/{len(texts)}] "
            f"tokens={gen_tokens} time={elapsed_ms:.0f}ms tps={tps:.1f} "
            f"| {translation[:80]}",
            file=sys.stderr,
        )
        sys.stderr.flush()

    total_elapsed = time.time() - total_start
    avg_tps = total_tokens / total_elapsed if total_elapsed > 0 else 0
    print(
        f"[AfriqueGemma-llamacpp] Done: {len(translations)} translations, "
        f"{total_tokens} tokens, {total_elapsed:.1f}s total, {avg_tps:.1f} avg tok/s",
        file=sys.stderr,
    )

    return translations


if __name__ == "__main__":
    source = os.environ.get("SRC")
    target = os.environ.get("TRG")

    if not source or not target:
        print("ERROR: SRC and TRG environment variables must be set", file=sys.stderr)
        sys.exit(1)

    input_lines = [line.rstrip("\n\r") for line in sys.stdin]

    if not input_lines:
        sys.exit(0)

    results = translate(input_lines, source, target)

    for t in results:
        print(t)
