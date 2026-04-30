"""
AfriqueGemma LLM Translator wrapper for evaluation framework
Uses qvac-lib-infer-llamacpp-llm via Bare runtime (bare_infer.js)

Translates by constructing completion-style prompts and invoking the LLM addon
with greedy decoding + reverse-prompt stop at newline.

Environment variables:
  SRC               - source language code (e.g. "en")
  TRG               - target language code (e.g. "sw")
  AFRIQUEGEMMA_GGUF_PATH  - path to GGUF model (default: ~/.qvac/models/AfriqueGemma-4B-Q4_K_M.gguf)
  AFRIQUEGEMMA_MAX_TOKENS - max tokens per translation (default: 256)
  AFRIQUEGEMMA_HF_REPO    - HuggingFace repo for auto-download (default: McGill-NLP/AfriqueGemma-4B-GGUF)
  AFRIQUEGEMMA_HF_FILE    - filename inside the HF repo (default: AfriqueGemma-4B-Q4_K_M.gguf)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

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

# Path to bare_infer.js in the LLM addon
# Navigate: translators/ -> quality_eval/ -> benchmarks/ -> nmtcpp/ -> packages/ -> llamacpp-llm/
LLM_ADDON_DIR = (
    Path(__file__).parent.parent.parent.parent.parent / "qvac-lib-infer-llamacpp-llm"
)
BARE_INFER_SCRIPT = LLM_ADDON_DIR / "benchmarks" / "server" / "bare_infer.js"
BARE_INFER_CWD = LLM_ADDON_DIR / "benchmarks" / "server"

MODELS_DIR = Path.home() / ".qvac" / "models"

DEFAULT_GGUF_PATHS = [
    MODELS_DIR / "AfriqueGemma-4B.Q4_K_M.gguf",
    MODELS_DIR / "AfriqueGemma-4B-Q4_K_M.gguf",
]

HF_REPO_DEFAULT = "mradermacher/AfriqueGemma-4B-GGUF"
HF_FILE_DEFAULT = "AfriqueGemma-4B.Q4_K_M.gguf"


def download_from_huggingface(repo_id, filename, dest_dir):
    """Download a GGUF file from HuggingFace Hub to dest_dir.

    Tries huggingface_hub first, falls back to direct URL download.
    Returns the local path on success, None on failure.
    """
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / filename

    # --- Attempt 1: huggingface_hub ---
    try:
        from huggingface_hub import hf_hub_download

        print(f"[AfriqueGemma] Downloading {filename} from hf://{repo_id} ...", file=sys.stderr)
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
            print(f"[AfriqueGemma] Downloaded {filename} ({size_mb:.0f} MB) -> {dest_path}", file=sys.stderr)
            return str(dest_path)
    except ImportError:
        print("[AfriqueGemma] huggingface_hub not installed, trying direct URL ...", file=sys.stderr)
    except Exception as e:
        print(f"[AfriqueGemma] huggingface_hub download failed: {e}", file=sys.stderr)

    # --- Attempt 2: direct HTTPS download ---
    url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
    print(f"[AfriqueGemma] Downloading {url} ...", file=sys.stderr)
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
                        print(f"\r[AfriqueGemma]   {pct}% ({downloaded // (1024*1024)} / {total // (1024*1024)} MB)",
                              end="", file=sys.stderr)
            print("", file=sys.stderr)

        if dest_path.exists() and dest_path.stat().st_size > 0:
            size_mb = dest_path.stat().st_size / (1024 * 1024)
            print(f"[AfriqueGemma] Downloaded {filename} ({size_mb:.0f} MB) -> {dest_path}", file=sys.stderr)
            return str(dest_path)
    except Exception as e:
        print(f"[AfriqueGemma] Direct download failed: {e}", file=sys.stderr)
        if dest_path.exists():
            dest_path.unlink()

    return None


def resolve_gguf_path():
    """Resolve the GGUF model path from env, local defaults, or auto-download."""
    # 1. Explicit env var
    env_path = os.environ.get("AFRIQUEGEMMA_GGUF_PATH")
    if env_path:
        p = Path(env_path)
        if p.exists():
            return str(p)
        print(f"[AfriqueGemma] WARNING: AFRIQUEGEMMA_GGUF_PATH={env_path} not found", file=sys.stderr)

    # 2. Default local paths
    for p in DEFAULT_GGUF_PATHS:
        if p.exists():
            return str(p)

    # 3. Auto-download from HuggingFace
    repo_id = os.environ.get("AFRIQUEGEMMA_HF_REPO", HF_REPO_DEFAULT)
    hf_file = os.environ.get("AFRIQUEGEMMA_HF_FILE", HF_FILE_DEFAULT)
    print(f"[AfriqueGemma] Model not found locally, attempting download from {repo_id} ...", file=sys.stderr)

    downloaded = download_from_huggingface(repo_id, hf_file, str(MODELS_DIR))
    if downloaded:
        return downloaded

    print("[AfriqueGemma] ERROR: No GGUF model found and auto-download failed.", file=sys.stderr)
    print(f"  Set AFRIQUEGEMMA_GGUF_PATH or place model in {MODELS_DIR}/", file=sys.stderr)
    print(f"  Or set AFRIQUEGEMMA_HF_REPO / AFRIQUEGEMMA_HF_FILE for a custom HF source.", file=sys.stderr)
    sys.exit(1)


def build_prompt(src_lang, trg_lang, sentence):
    """Build a completion-style translation prompt."""
    src_name = LANG_NAMES.get(src_lang, src_lang)
    trg_name = LANG_NAMES.get(trg_lang, trg_lang)
    return f"Translate {src_name} to {trg_name}.\n{src_name}: {sentence}\n{trg_name}:"


def translate(texts, src_lang, trg_lang):
    """Translate a list of sentences using AfriqueGemma via bare_infer.js."""

    bare_bin = shutil.which("bare")
    if not bare_bin:
        print("[AfriqueGemma] ERROR: 'bare' runtime not found in PATH", file=sys.stderr)
        sys.exit(1)

    if not BARE_INFER_SCRIPT.exists():
        print(f"[AfriqueGemma] ERROR: bare_infer.js not found at {BARE_INFER_SCRIPT}", file=sys.stderr)
        sys.exit(1)

    gguf_path = resolve_gguf_path()
    max_tokens = os.environ.get("AFRIQUEGEMMA_MAX_TOKENS", "256")

    prompts = [build_prompt(src_lang, trg_lang, text) for text in texts]

    work_dir = tempfile.mkdtemp(prefix="afriquegemma_eval_")
    prompts_file = os.path.join(work_dir, "prompts.json")
    outputs_file = os.path.join(work_dir, "outputs.json")

    try:
        with open(prompts_file, "w", encoding="utf-8") as f:
            json.dump(prompts, f, ensure_ascii=False)

        cmd = [
            bare_bin,
            str(BARE_INFER_SCRIPT.resolve()),
            gguf_path,
            prompts_file,
            outputs_file,
            max_tokens,
        ]

        print(f"[AfriqueGemma] Model: {gguf_path}", file=sys.stderr)
        print(f"[AfriqueGemma] Translating {len(texts)} sentences: {src_lang} -> {trg_lang}", file=sys.stderr)
        print(f"[AfriqueGemma] Command: {' '.join(cmd)}", file=sys.stderr)
        sys.stderr.flush()

        start_time = time.time()

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=str(BARE_INFER_CWD.resolve()),
        )

        for line in proc.stdout:
            line = line.rstrip("\n")
            if line:
                print(f"[AfriqueGemma] {line}", file=sys.stderr)
                sys.stderr.flush()

        returncode = proc.wait()
        elapsed = time.time() - start_time

        if returncode != 0:
            print(f"[AfriqueGemma] ERROR: bare_infer.js exited with code {returncode}", file=sys.stderr)
            return [""] * len(texts)

        with open(outputs_file, "r", encoding="utf-8") as f:
            translations = json.load(f)

        print(f"[AfriqueGemma] Completed {len(translations)} translations in {elapsed:.1f}s", file=sys.stderr)

        if len(translations) < len(texts):
            missing = len(texts) - len(translations)
            print(f"[AfriqueGemma] WARNING: padding {missing} missing translations", file=sys.stderr)
            translations.extend([""] * missing)
        elif len(translations) > len(texts):
            translations = translations[:len(texts)]

        return translations

    finally:
        import shutil as _shutil
        _shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    source = os.environ.get("SRC")
    target = os.environ.get("TRG")

    if not source or not target:
        print("ERROR: SRC and TRG environment variables must be set", file=sys.stderr)
        sys.exit(1)

    input_lines = [line.rstrip("\n\r") for line in sys.stdin]

    if not input_lines:
        sys.exit(0)

    translations = translate(input_lines, source, target)

    for translation in translations:
        print(translation)
