"""
GGUF Oracle Validation Script

Compares AfriqueGemma 4B GGUF (quantized) against the HuggingFace transformers
reference oracle. Runs models sequentially to fit within memory constraints.

Supports two comparison modes (selectable via --compare):
  - token:  Token-level via qvac addon server (tests real production pipeline)
  - logits: Logits-level via llama-cpp-python (requires llama-cpp-python package)

Usage:
  # Both comparisons (default)
  python validate_gguf_oracle.py \
    --gguf-model "mradermacher/AfriqueGemma-4B-GGUF:Q4_K_M" \
    --transformers-model "McGill-NLP/AfriqueGemma-4B" \
    --compare token,logits

  # Token-only (no llama-cpp-python needed, uses qvac addon server)
  python validate_gguf_oracle.py \
    --gguf-model "mradermacher/AfriqueGemma-4B-GGUF:Q4_K_M" \
    --transformers-model "McGill-NLP/AfriqueGemma-4B" \
    --compare token

  # Logits-only (uses llama-cpp-python)
  python validate_gguf_oracle.py \
    --gguf-model "mradermacher/AfriqueGemma-4B-GGUF:Q4_K_M" \
    --transformers-model "McGill-NLP/AfriqueGemma-4B" \
    --compare logits
"""

import argparse
import gc
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logging.getLogger("transformers").setLevel(logging.ERROR)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thresholds (tuned for Q4_K_M quantization)
# ---------------------------------------------------------------------------
TOKEN_OVERLAP_THRESHOLD = 0.60
COSINE_SIMILARITY_THRESHOLD = 0.90
TOP_K_OVERLAP_THRESHOLD = 0.70
TOP_K = 10

# ---------------------------------------------------------------------------
# Test prompts — African language translation cases (En<->X)
# AfriqueGemma-4B supports 20 African languages + En/Fr/Pt/Ar
# Uses completion-style prompts (base model, not instruction-tuned)
# ---------------------------------------------------------------------------
TEST_PROMPTS = [
    # En -> African languages
    "Translate English to Swahili.\nEnglish: The children are playing in the park.\nSwahili:",
    "Translate English to Yoruba.\nEnglish: Good morning, how are you today?\nYoruba:",
    "Translate English to Hausa.\nEnglish: Water is essential for life.\nHausa:",
    "Translate English to Zulu.\nEnglish: The sun rises in the east.\nZulu:",
    # African languages -> En
    "Translate Swahili to English.\nSwahili: Watoto wanacheza kwenye bustani.\nEnglish:",
    "Translate Yoruba to English.\nYoruba: Omi jẹ pataki fun igbesi aye.\nEnglish:",
    "Translate Amharic to English.\nAmharic: ፀሐይ በምስራቅ ትወጣለች\nEnglish:",
    # French (high-resource lang in AfriqueGemma) -> En
    "Translate French to English.\nFrench: Les enfants jouent dans le jardin.\nEnglish:",
]


# ============================= CLI =========================================

def parse_args():
    parser = argparse.ArgumentParser(
        description="Validate GGUF model against HuggingFace transformers oracle",
    )
    parser.add_argument(
        "--gguf-model",
        required=True,
        help='GGUF model spec, e.g. "mradermacher/AfriqueGemma-4B-GGUF:Q4_K_M"',
    )
    parser.add_argument(
        "--transformers-model",
        required=True,
        help='HuggingFace model name, e.g. "McGill-NLP/AfriqueGemma-4B"',
    )
    parser.add_argument("--hf-token", default=None, help="HuggingFace token")
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=50,
        help="Max tokens to generate per prompt (default: 50)",
    )
    parser.add_argument(
        "--compare",
        default="token,logits",
        help=(
            "Comma-separated comparison modes: token, logits, or token,logits. "
            "token = qvac addon server (production pipeline). "
            "logits = llama-cpp-python (logit distributions). "
            "(default: token,logits)"
        ),
    )
    parser.add_argument(
        "--device",
        default="cpu",
        help="Device for inference: cpu or gpu (default: cpu)",
    )
    parser.add_argument(
        "--token-threshold",
        type=float,
        default=TOKEN_OVERLAP_THRESHOLD,
        help=f"Token overlap pass threshold (default: {TOKEN_OVERLAP_THRESHOLD})",
    )
    parser.add_argument(
        "--cosine-threshold",
        type=float,
        default=COSINE_SIMILARITY_THRESHOLD,
        help=f"Cosine similarity pass threshold (default: {COSINE_SIMILARITY_THRESHOLD})",
    )
    parser.add_argument(
        "--topk-threshold",
        type=float,
        default=TOP_K_OVERLAP_THRESHOLD,
        help=f"Top-k overlap pass threshold (default: {TOP_K_OVERLAP_THRESHOLD})",
    )
    return parser.parse_args()


def parse_compare_modes(compare_str: str) -> set[str]:
    modes = {m.strip().lower() for m in compare_str.split(",")}
    valid = {"token", "logits"}
    invalid = modes - valid
    if invalid:
        logger.error(f"Invalid --compare modes: {invalid}. Valid: {valid}")
        sys.exit(1)
    return modes


def parse_gguf_spec(spec: str) -> tuple[str, str | None]:
    """Parse 'owner/repo:quantization' into (repo_id, quantization)."""
    if ":" in spec:
        repo, quant = spec.rsplit(":", 1)
        return repo, quant
    return spec, None


# ============================= PHASE 1: Transformers =======================

def run_transformers_phase(
    model_name: str,
    hf_token: str | None,
    prompts: list[str],
    max_tokens: int,
    output_dir: str,
    need_logits: bool,
    need_tokens: bool,
) -> tuple[dict, int]:
    """Load transformers model, generate tokens and/or capture logits, save to disk."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    logger.info("=" * 60)
    logger.info("PHASE 1: HuggingFace Transformers Reference Oracle")
    logger.info("=" * 60)
    logger.info(f"Model: {model_name}")
    logger.info("Precision: bfloat16 (reference oracle)")

    tokenizer = AutoTokenizer.from_pretrained(model_name, token=hf_token)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.bfloat16,
        device_map={"": "cpu"},
        token=hf_token,
    )
    model.eval()
    logger.info("Model loaded successfully")

    results = {"texts": [], "logits_last": []}

    for i, prompt in enumerate(prompts):
        logger.info(f"  Prompt {i + 1}/{len(prompts)}: {prompt[:60]}...")

        if need_logits:
            # Raw prompt tokenization for logits (matches llama-cpp-python phase)
            inputs = tokenizer(prompt, return_tensors="pt")
            input_len = inputs["input_ids"].shape[1]
            with torch.no_grad():
                fwd = model(**inputs)
            last_logits = fwd.logits[0, -1, :].float().cpu().numpy()
            results["logits_last"].append(last_logits)

        if need_tokens:
            # Apply chat template to match addon behavior (addon wraps as user message)
            messages = [{"role": "user", "content": prompt}]
            chat_text = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            chat_input = tokenizer(chat_text, return_tensors="pt")
            input_len = chat_input["input_ids"].shape[1]
            newline_token_id = tokenizer.encode("\n", add_special_tokens=False)[-1]
            with torch.no_grad():
                gen_out = model.generate(
                    **chat_input,
                    max_new_tokens=max_tokens,
                    do_sample=False,
                    pad_token_id=tokenizer.eos_token_id,
                    eos_token_id=[tokenizer.eos_token_id, newline_token_id],
                )
            new_token_ids = gen_out[0][input_len:].tolist()
            generated_text = tokenizer.decode(new_token_ids, skip_special_tokens=True)
            generated_text = generated_text.split("\n")[0].strip()
            results["texts"].append(generated_text)
            logger.info(f"    Output: {generated_text}")

    # Save intermediate results
    if need_logits:
        path = os.path.join(output_dir, "transformers_logits.npz")
        np.savez(path, **{f"logits_{i}": lg for i, lg in enumerate(results["logits_last"])})
        logger.info(f"  Saved: {path}")
    if need_tokens:
        path = os.path.join(output_dir, "transformers_texts.json")
        with open(path, "w") as f:
            json.dump(results["texts"], f, ensure_ascii=False, indent=2)
        logger.info(f"  Saved: {path}")

    vocab_size = results["logits_last"][0].shape[0] if results["logits_last"] else 0

    del model, tokenizer
    gc.collect()
    try:
        import torch as _torch
        _torch.cuda.empty_cache()
    except Exception:
        pass

    logger.info("Phase 1 complete — model unloaded\n")
    return results, vocab_size


# ============================= PHASE 2a: qvac addon (tokens) ===============

BARE_INFER_SCRIPT = os.path.join(
    os.path.dirname(__file__), "..", "server", "bare_infer.js"
)
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..", "server")


def run_addon_token_phase(
    gguf_path: str,
    prompts: list[str],
    max_tokens: int,
    device: str,
    output_dir: str,
) -> dict:
    """Run GGUF inference via bare subprocess (LlmLlamacpp addon directly)."""

    logger.info("=" * 60)
    logger.info("PHASE 2a: GGUF Token Generation via qvac Addon (bare)")
    logger.info("=" * 60)
    logger.info(f"Model: {gguf_path}")

    bare_bin = shutil.which("bare")
    if not bare_bin:
        logger.error("'bare' runtime not found in PATH. Install it or add to PATH.")
        sys.exit(1)

    prompts_file = os.path.join(output_dir, "prompts.json")
    outputs_file = os.path.join(output_dir, "addon_texts.json")

    with open(prompts_file, "w") as f:
        json.dump(prompts, f)

    cmd = [
        bare_bin,
        os.path.abspath(BARE_INFER_SCRIPT),
        gguf_path,
        prompts_file,
        outputs_file,
        str(max_tokens),
    ]
    logger.info(f"Running: {' '.join(cmd)}")

    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=600,
        cwd=os.path.abspath(SERVER_DIR),
    )

    if result.stdout:
        for line in result.stdout.strip().split("\n"):
            logger.info(f"  [bare] {line}")
    if result.stderr:
        for line in result.stderr.strip().split("\n"):
            logger.warning(f"  [bare] {line}")

    if result.returncode != 0:
        logger.error(f"bare_infer.js failed with exit code {result.returncode}")
        sys.exit(1)

    with open(outputs_file) as f:
        texts = json.load(f)

    results = {"texts": texts}
    logger.info(f"  Saved: {outputs_file}")
    logger.info(f"Phase 2a complete — {len(texts)} outputs collected\n")
    return results


# ============================= PHASE 2b: llama-cpp-python (logits) =========

def run_llamacpp_logits_phase(
    gguf_path: str,
    prompts: list[str],
    output_dir: str,
    vocab_size: int,
) -> dict:
    """Load GGUF via llama-cpp-python, capture logits at last prompt position."""
    from llama_cpp import Llama

    logger.info("=" * 60)
    logger.info("PHASE 2b: GGUF Logits Capture via llama-cpp-python")
    logger.info("=" * 60)
    logger.info(f"Model: {gguf_path}")

    llm = Llama(
        model_path=gguf_path,
        n_ctx=2048,
        n_batch=512,
        logits_all=True,
        verbose=False,
    )
    logger.info("Model loaded successfully")

    results = {"logits_last": []}

    for i, prompt in enumerate(prompts):
        logger.info(f"  Prompt {i + 1}/{len(prompts)}: {prompt[:60]}...")

        prompt_tokens = llm.tokenize(prompt.encode("utf-8"), add_bos=True)
        llm.reset()
        llm.eval(prompt_tokens)

        n_vocab_gguf = llm.n_vocab()
        raw_scores = llm.scores[len(prompt_tokens) - 1, :n_vocab_gguf]
        last_logits = np.array(raw_scores, dtype=np.float32)

        if last_logits.shape[0] < vocab_size:
            last_logits = np.pad(last_logits, (0, vocab_size - last_logits.shape[0]))
        elif last_logits.shape[0] > vocab_size:
            last_logits = last_logits[:vocab_size]

        results["logits_last"].append(last_logits)
        logger.info(f"    Captured logits (vocab_size={last_logits.shape[0]})")

    path = os.path.join(output_dir, "gguf_logits.npz")
    np.savez(path, **{f"logits_{i}": lg for i, lg in enumerate(results["logits_last"])})
    logger.info(f"  Saved: {path}")

    del llm
    gc.collect()
    logger.info("Phase 2b complete — model unloaded\n")
    return results


# ============================= PHASE 3: Comparison =========================

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def top_k_overlap(a: np.ndarray, b: np.ndarray, k: int = TOP_K) -> float:
    top_a = set(np.argsort(a)[-k:])
    top_b = set(np.argsort(b)[-k:])
    return len(top_a & top_b) / k


def word_overlap_ratio(text_a: str, text_b: str) -> float:
    """Word-level LCS ratio between two generated texts."""
    if not text_a.strip() and not text_b.strip():
        return 1.0
    if not text_a.strip() or not text_b.strip():
        return 0.0

    words_a = text_a.lower().split()
    words_b = text_b.lower().split()
    if not words_a and not words_b:
        return 1.0
    if not words_a or not words_b:
        return 0.0

    m, n = len(words_a), len(words_b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if words_a[i - 1] == words_b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    lcs_len = dp[m][n]
    return (2.0 * lcs_len) / (m + n)


def run_comparison(
    prompts: list[str],
    tf_results: dict,
    addon_results: dict | None,
    logits_results: dict | None,
    token_threshold: float,
    cosine_threshold: float,
    topk_threshold: float,
    modes: set[str],
) -> bool:
    """Compare results and print verdict. Returns True if all enabled checks pass."""
    n = len(prompts)
    sep = "=" * 70

    all_pass = True

    print(f"\n{sep}")
    print("VALIDATION RESULTS: GGUF vs Transformers Oracle")
    print(sep)

    # ---- Token-level comparison ----
    if "token" in modes and addon_results and tf_results.get("texts"):
        print(f"\nTOKEN-LEVEL COMPARISON (greedy decoding, via qvac addon):")
        print("-" * 70)

        token_scores = []
        for i in range(n):
            tf_text = tf_results["texts"][i]
            addon_text = addon_results["texts"][i]
            overlap = word_overlap_ratio(tf_text, addon_text)
            token_scores.append(overlap)

            status = "PASS" if overlap >= token_threshold else "FAIL"
            print(f"  Prompt {i + 1}: {overlap:.1%} word overlap  {status}")
            print(f"    Oracle : {tf_text[:120]}")
            print(f"    Addon  : {addon_text[:120]}")

        mean_token = float(np.mean(token_scores))
        token_pass = mean_token >= token_threshold
        all_pass = all_pass and token_pass

        print("-" * 70)
        status = "PASS" if token_pass else "FAIL"
        print(
            f"  Mean word overlap: {mean_token:.1%}    "
            f"{status} (threshold: {token_threshold:.0%})"
        )

    # ---- Logits-level comparison ----
    if "logits" in modes and logits_results and tf_results.get("logits_last"):
        print(f"\nLOGITS-LEVEL COMPARISON (last prompt position, via llama-cpp-python):")
        print("-" * 70)

        cosine_scores = []
        topk_scores = []
        for i in range(n):
            cos_sim = cosine_similarity(
                tf_results["logits_last"][i], logits_results["logits_last"][i]
            )
            topk_ov = top_k_overlap(
                tf_results["logits_last"][i], logits_results["logits_last"][i]
            )
            cosine_scores.append(cos_sim)
            topk_scores.append(topk_ov)

            c_status = "PASS" if cos_sim >= cosine_threshold else "FAIL"
            t_status = "PASS" if topk_ov >= topk_threshold else "FAIL"
            print(
                f"  Prompt {i + 1}: cosine={cos_sim:.4f} {c_status}, "
                f"top-{TOP_K}_overlap={topk_ov:.0%} {t_status}"
            )

        mean_cosine = float(np.mean(cosine_scores))
        mean_topk = float(np.mean(topk_scores))
        cosine_pass = mean_cosine >= cosine_threshold
        topk_pass = mean_topk >= topk_threshold
        all_pass = all_pass and cosine_pass and topk_pass

        print("-" * 70)
        c_status = "PASS" if cosine_pass else "FAIL"
        t_status = "PASS" if topk_pass else "FAIL"
        print(
            f"  Mean cosine similarity: {mean_cosine:.4f}    "
            f"{c_status} (threshold: {cosine_threshold})"
        )
        print(
            f"  Mean top-{TOP_K} overlap:    {mean_topk:.1%}       "
            f"{t_status} (threshold: {topk_threshold:.0%})"
        )

    print(f"\n{sep}")
    verdict = "PASS" if all_pass else "FAIL"
    print(f"OVERALL VERDICT: {verdict}")
    print(f"{sep}\n")

    return all_pass


# ============================= MAIN ========================================

def main():
    args = parse_args()
    modes = parse_compare_modes(args.compare)

    logger.info(f"Comparison modes: {modes}")

    repo_id, quantization = parse_gguf_spec(args.gguf_model)

    from model_handler import download_gguf_from_huggingface

    gguf_path = download_gguf_from_huggingface(
        repo_id, quantization, hf_token=args.hf_token
    )
    logger.info(f"GGUF model path: {gguf_path}")

    work_dir = tempfile.mkdtemp(prefix="gguf_validate_")
    logger.info(f"Working directory: {work_dir}")

    need_tokens = "token" in modes
    need_logits = "logits" in modes

    # Phase 1: Transformers reference oracle
    tf_results, vocab_size = run_transformers_phase(
        model_name=args.transformers_model,
        hf_token=args.hf_token,
        prompts=TEST_PROMPTS,
        max_tokens=args.max_tokens,
        output_dir=work_dir,
        need_logits=need_logits,
        need_tokens=need_tokens,
    )

    # Phase 2a: Token generation via qvac addon server
    addon_results = None
    if need_tokens:
        addon_results = run_addon_token_phase(
            gguf_path=gguf_path,
            prompts=TEST_PROMPTS,
            max_tokens=args.max_tokens,
            device=args.device,
            output_dir=work_dir,
        )

    # Phase 2b: Logits capture via llama-cpp-python
    logits_results = None
    if need_logits:
        logits_results = run_llamacpp_logits_phase(
            gguf_path=gguf_path,
            prompts=TEST_PROMPTS,
            output_dir=work_dir,
            vocab_size=vocab_size,
        )

    # Log all output files
    logger.info("=" * 60)
    logger.info("OUTPUT FILES")
    logger.info("=" * 60)
    for fname in sorted(os.listdir(work_dir)):
        fpath = os.path.join(work_dir, fname)
        size = os.path.getsize(fpath)
        logger.info(f"  {fpath}  ({size:,} bytes)")
    logger.info("")

    # Phase 3: Compare and verdict
    passed = run_comparison(
        prompts=TEST_PROMPTS,
        tf_results=tf_results,
        addon_results=addon_results,
        logits_results=logits_results,
        token_threshold=args.token_threshold,
        cosine_threshold=args.cosine_threshold,
        topk_threshold=args.topk_threshold,
        modes=modes,
    )

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
