#!/usr/bin/env python3
"""
Translation Quality Evaluation Framework
Compares QVAC, OpusMT, Google Translate, and NLLB using BLEU scores on Flores datasets
"""

import os
import sys
import subprocess
import shutil
import traceback
import click
import time
import json
from pathlib import Path

# Dataset configuration
DATASETS = {
    "flores-dev": {
        "type": "flores",
        "folder": "flores200_dataset",
        "split": "dev"
    },
    "flores-devtest": {
        "type": "flores",
        "folder": "flores200_dataset",
        "split": "devtest"
    },
    "conversational-phrases": {
        "type": "json",
        "folder": "conversational_phrases",
        "remote_path": os.environ.get('CONVERSATIONAL_PHRASES_PATH', '')
    }
}

# Language code mapping for Flores datasets
FLORES_LANG_CODES = {
    "flores200_dataset": {
        "ar": "arb_Arab",
        "be": "bel_Cyrl",
        "bs": "bos_Latn",
        "gu": "guj_Gujr",
        "hr": "hrv_Latn",
        "kn": "kan_Knda",
        "ml": "mal_Mlym",
        "sq": "sqi_Latn",
        "mt": "mlt_Latn",
        "nb": "nob_Latn",
        "nn": "nno_Latn",
        "sr": "srp_Cyrl",
        "sv": "swe_Latn",
        "bg": "bul_Cyrl",
        "bn": "ben_Beng",
        "ca": "cat_Latn",
        "cs": "ces_Latn",
        "da": "dan_Latn",
        "de": "deu_Latn",
        "el": "ell_Grek",
        "en": "eng_Latn",
        "es": "spa_Latn",
        "et": "est_Latn",
        "fa": "pes_Arab",
        "fi": "fin_Latn",
        "fr": "fra_Latn",
        "he": "heb_Hebr",
        "hi": "hin_Deva",
        "hu": "hun_Latn",
        "id": "ind_Latn",
        "is": "isl_Latn",
        "it": "ita_Latn",
        "ja": "jpn_Jpan",
        "ko": "kor_Hang",
        "lt": "lit_Latn",
        "lv": "lvs_Latn",
        "mr": "mar_Deva",
        "ms": "zsm_Latn",
        "nl": "nld_Latn",
        "no": "nob_Latn",
        "pl": "pol_Latn",
        "pt": "por_Latn",
        "ro": "ron_Latn",
        "ru": "rus_Cyrl",
        "sk": "slk_Latn",
        "sl": "slv_Latn",
        "sv": "swe_Latn",
        "ta": "tam_Taml",
        "te": "tel_Telu",
        "th": "tha_Thai",
        "tl": "tgl_Latn",
        "tr": "tur_Latn",
        "uk": "ukr_Cyrl",
        "ur": "urd_Arab",
        "vi": "vie_Latn",
        "zh": "zho_Hans",
        "sw": "swh_Latn",
        "yo": "yor_Latn",
        "ha": "hau_Latn",
        "zu": "zul_Latn",
        "am": "amh_Ethi",
        "ig": "ibo_Latn",
        "wo": "wol_Latn",
        "sn": "sna_Latn",
        "rw": "kin_Latn",
        "lg": "lug_Latn",
        "ts": "tso_Latn",
        "tw": "twi_Latn",
        "xh": "xho_Latn",
        "ny": "nya_Latn",
        "so": "som_Latn",
        "ln": "lin_Latn"
    }
}

# Supported language pairs per translator
SUPPORTED_PAIRS = {
    "qvac": {
        # European languages - bidirectional with English
        ("en", "de"), ("en", "es"), ("en", "it"), ("en", "fr"), ("en", "pt"),
        ("en", "da"), ("en", "no"), ("en", "uk"), ("en", "ro"), ("en", "bg"),
        ("en", "sk"), ("en", "lt"), ("en", "lv"), ("en", "sl"), ("en", "et"),
        ("en", "nl"), ("en", "sv"), ("en", "cs"), ("en", "el"), ("en", "fi"), ("en", "he"),
        ("de", "en"), ("de", "es"), ("de", "it"), ("de", "fr"),
        ("es", "en"), ("es", "de"), ("es", "it"), ("es", "fr"),
        ("it", "en"), ("it", "de"), ("it", "es"), ("it", "fr"),
        ("fr", "en"), ("fr", "de"), ("fr", "es"), ("fr", "it"),
        ("pt", "en"),
        ("da", "en"), ("no", "en"), ("uk", "en"), ("ro", "en"), ("bg", "en"),
        ("sk", "en"), ("lt", "en"), ("lv", "en"), ("sl", "en"), ("et", "en"),
        ("nl", "en"), ("sv", "en"), ("pl", "en"), ("cs", "en"), ("fi", "en"), ("id", "en"),

        # Asian/Middle Eastern languages - bidirectional with English
        ("en", "zh"), ("en", "ar"), ("en", "hi"), ("en", "ru"), ("en", "ja"),
        ("en", "vi"), ("en", "th"), ("en", "ms"), ("en", "tl"), ("en", "bn"),
        ("en", "ta"), ("en", "te"), ("en", "mr"), ("en", "ur"), ("en", "fa"), ("en", "id"),
        ("zh", "en"), ("ar", "en"), ("hi", "en"), ("ru", "en"), ("ja", "en"),
        ("tr", "en"), ("ko", "en"), ("vi", "en"), ("th", "en"), ("ms", "en"),
        ("tl", "en"), ("bn", "en"), ("ta", "en"), ("te", "en"), ("mr", "en"),
        ("ur", "en"), ("fa", "en")
    },
    "opusmt": set(),  # OpusMT has many pairs, let it try all
    "google": set(),  # Google supports almost all pairs
    "nllb": set(),  # NLLB supports many pairs
    "bergamot": set(),  # Bergamot supports many pairs via translatelocally.com
    "qvac_bergamot": set(),  # QVAC backend with Bergamot/Firefox model format
    "afriquegemma_llm": {
        # AfriqueGemma-4B: 20 African languages + En/Fr/Pt/Ar — bidirectional with English
        ("en", "sw"), ("en", "yo"), ("en", "ha"), ("en", "zu"), ("en", "am"),
        ("en", "ig"), ("en", "wo"), ("en", "sn"), ("en", "rw"), ("en", "lg"),
        ("en", "ts"), ("en", "tw"), ("en", "xh"), ("en", "ny"), ("en", "so"), ("en", "ln"),
        ("sw", "en"), ("yo", "en"), ("ha", "en"), ("zu", "en"), ("am", "en"),
        ("ig", "en"), ("wo", "en"), ("sn", "en"), ("rw", "en"), ("lg", "en"),
        ("ts", "en"), ("tw", "en"), ("xh", "en"), ("ny", "en"), ("so", "en"), ("ln", "en"),
        # High-resource languages supported by AfriqueGemma
        ("en", "fr"), ("fr", "en"), ("en", "pt"), ("pt", "en"),
        ("en", "ar"), ("ar", "en"),
        # Cross-lingual African pairs via AfriqueGemma
        ("fr", "sw"), ("sw", "fr"), ("fr", "yo"), ("yo", "fr"),
        ("fr", "ha"), ("ha", "fr"), ("fr", "wo"), ("wo", "fr"),
    },
    "afriquegemma_llamacpp": {
        ("en", "sw"), ("en", "yo"), ("en", "ha"), ("en", "zu"), ("en", "am"),
        ("en", "ig"), ("en", "wo"), ("en", "sn"), ("en", "rw"), ("en", "lg"),
        ("en", "ts"), ("en", "tw"), ("en", "xh"), ("en", "ny"), ("en", "so"), ("en", "ln"),
        ("sw", "en"), ("yo", "en"), ("ha", "en"), ("zu", "en"), ("am", "en"),
        ("ig", "en"), ("wo", "en"), ("sn", "en"), ("rw", "en"), ("lg", "en"),
        ("ts", "en"), ("tw", "en"), ("xh", "en"), ("ny", "en"), ("so", "en"), ("ln", "en"),
        ("en", "fr"), ("fr", "en"), ("en", "pt"), ("pt", "en"),
        ("en", "ar"), ("ar", "en"),
        ("fr", "sw"), ("sw", "fr"), ("fr", "yo"), ("yo", "fr"),
        ("fr", "ha"), ("ha", "fr"), ("fr", "wo"), ("wo", "fr"),
    },
}


def download_dataset(data_dir, dataset_name="flores-devtest"):
    """Download dataset if not already present"""
    config = DATASETS[dataset_name]
    dataset_path = Path(data_dir) / config["folder"]

    if dataset_path.exists():
        print(f"Dataset already exists: {dataset_path}")
        return

    print(f"Downloading {dataset_name}...")
    data_dir_path = Path(data_dir)
    data_dir_path.mkdir(parents=True, exist_ok=True)

    if config["type"] == "flores":
        # Download Flores200 dataset
        url = "https://tinyurl.com/flores200dataset"

        # Download and extract
        tarball = data_dir_path / f"{config['folder']}.tar.gz"
        subprocess.run(["wget", "-O", str(tarball), url], check=True)
        subprocess.run(["tar", "-xzf", str(tarball), "-C", str(data_dir)], check=True)
        tarball.unlink()  # Remove tarball after extraction
    elif config["type"] == "json":
        # Download JSON dataset from S3
        remote_path = config["remote_path"]
        if not remote_path:
            raise ValueError(f"Set CONVERSATIONAL_PHRASES_PATH env var to download {dataset_name}")
        if not remote_path.startswith("s3://"):
            raise ValueError(f"CONVERSATIONAL_PHRASES_PATH must be an s3:// URL, got: {remote_path}")
        dataset_path.mkdir(parents=True, exist_ok=True)
        json_file = dataset_path / "dataset.json"
        subprocess.run(["aws", "s3", "cp", remote_path, str(json_file)], check=True)

    print(f"Downloaded and extracted {dataset_name}")


def copy_dataset_files(dataset_name, src_lang, trg_lang, results_dir, data_dir):
    """Copy source and target files from dataset to results directory"""
    config = DATASETS[dataset_name]
    folder = config["folder"]

    # Destination paths
    pair_dir = Path(results_dir) / f"{src_lang}-{trg_lang}"
    pair_dir.mkdir(parents=True, exist_ok=True)

    dest_src = pair_dir / f"{dataset_name}.{src_lang}"
    dest_trg = pair_dir / f"{dataset_name}.{trg_lang}"

    if config["type"] == "flores":
        # Handle Flores dataset
        split = config["split"]

        # Get language codes for this dataset
        lang_map = FLORES_LANG_CODES[folder]
        src_code = lang_map[src_lang]
        trg_code = lang_map[trg_lang]

        # Source and target file paths in Flores dataset
        flores_dir = Path(data_dir) / folder / split
        src_file = flores_dir / f"{src_code}.{split}"
        trg_file = flores_dir / f"{trg_code}.{split}"

        # Copy files
        shutil.copy(src_file, dest_src)
        shutil.copy(trg_file, dest_trg)

    elif config["type"] == "json":
        # Handle JSON dataset
        json_file = Path(data_dir) / folder / "dataset.json"

        # Load JSON data
        with open(json_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Extract sentences for source and target languages
        src_sentences = []
        trg_sentences = []

        for entry in data:
            if src_lang in entry and trg_lang in entry:
                src_sentences.append(entry[src_lang])
                trg_sentences.append(entry[trg_lang])
            else:
                # Skip entries that don't have both languages
                print(f"Warning: Entry {entry.get('id', '?')} missing {src_lang} or {trg_lang}")

        # Write to files
        with open(dest_src, "w", encoding="utf-8") as f:
            f.write("\n".join(src_sentences) + "\n")

        with open(dest_trg, "w", encoding="utf-8") as f:
            f.write("\n".join(trg_sentences) + "\n")

        print(f"Extracted {len(src_sentences)} sentence pairs from JSON dataset")

    return dest_src, dest_trg


def truncate_file(filepath, max_lines):
    """Truncate a file to the first max_lines lines."""
    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()
    if len(lines) > max_lines:
        with open(filepath, "w", encoding="utf-8") as f:
            f.writelines(lines[:max_lines])
        return max_lines
    return len(lines)


def translate_file(translator, src_lang, trg_lang, input_file, output_file, use_pivot=False, is_quantized_model=False, hyperparams=None, use_batch=False):
    """Run translation using the specified translator. Returns elapsed time in seconds.

    Args:
        translator: Name of the translator to use
        src_lang: Source language code
        trg_lang: Target language code
        input_file: Path to input file
        output_file: Path to output file
        use_pivot: If True and src/trg are both non-English, translate via English
        hyperparams: Dictionary of hyperparameters (beamsize, lengthpenalty, etc.)
        use_batch: If True, use batch translation API (qvac_bergamot only)
    """

    # Set up environment
    env = os.environ.copy()
    env["SRC"] = src_lang
    env["TRG"] = trg_lang

    # Check if we should use pivot translation
    if use_pivot and src_lang != "en" and trg_lang != "en":
        env["USE_PIVOT"] = "true"
        print(f"  Using pivot translation: {src_lang} -> en -> {trg_lang}")
    else:
        env["USE_PIVOT"] = "false"

    # Check if we need to use quantized model -- only with QVAC backend
    if is_quantized_model and translator == "qvac":
        env["Q4_MODEL"] = "true"
    else:
        env["Q4_MODEL"] = "false"

    # Check if we should use batch translation -- only with qvac_bergamot backend
    if use_batch and translator == "qvac_bergamot":
        env["USE_BATCH"] = "true"
    else:
        env["USE_BATCH"] = "false"

    # Pass hyperparameters as environment variables
    if hyperparams:
        env["QVAC_BEAMSIZE"] = str(hyperparams.get("beamsize", 4))
        env["QVAC_LENGTHPENALTY"] = str(hyperparams.get("lengthpenalty", 1.0))
        env["QVAC_REPETITIONPENALTY"] = str(hyperparams.get("repetitionpenalty", 1.0))
        env["QVAC_NOREPEATNGRAMSIZE"] = str(hyperparams.get("norepeatngramsize", 0))
        env["QVAC_TEMPERATURE"] = str(hyperparams.get("temperature", 1.0))
        env["QVAC_TOPK"] = str(hyperparams.get("topk", 0))
        env["QVAC_TOPP"] = str(hyperparams.get("topp", 1.0))
        env["QVAC_MAXLENGTH"] = str(hyperparams.get("maxlength", 512))

    # Get translator script path
    script_dir = Path(__file__).parent / "translators"

    if translator == "qvac":
        cmd = ["python3", str(script_dir / "qvac.py")]
    elif translator == "qvac_bergamot":
        cmd = ["python3", str(script_dir / "qvac_bergamot.py")]
    elif translator == "opusmt":
        cmd = ["python3", str(script_dir / "opusmt.py")]
    elif translator == "google":
        cmd = ["python3", str(script_dir / "google_translate.py")]
    elif translator == "nllb":
        cmd = ["python3", str(script_dir / "nllb.py")]
    elif translator == "bergamot":
        cmd = ["python3.10", str(script_dir / "bergamot_translator.py")]
    elif translator == "afriquegemma_llm":
        cmd = ["python3", str(script_dir / "afriquegemma_llm.py")]
    elif translator == "afriquegemma_llamacpp":
        cmd = [sys.executable, str(script_dir / "afriquegemma_llamacpp.py")]
    else:
        raise ValueError(f"Unknown translator: {translator}")

    # Count input lines for logging
    with open(input_file, "r") as f:
        input_lines = sum(1 for _ in f)

    print(f"  Translating with {translator}...")
    print(f"  Input: {input_file} ({input_lines} lines)")
    print(f"  Output: {output_file}")
    print(f"  Command: {' '.join(cmd)}")
    if translator in ("qvac", "qvac_bergamot"):
        # Log QVAC-specific environment variables
        qvac_env_vars = {k: v for k, v in env.items() if k.startswith("QVAC_") or k == "FIREFOX_MODELS_DIR"}
        if qvac_env_vars:
            print(f"  QVAC params: {qvac_env_vars}")

    # Run translation and measure time
    start_time = time.time()
    print(f"  [STARTED at {time.strftime('%H:%M:%S')}]")
    sys.stdout.flush()

    # Run subprocess with stderr streaming for real-time progress
    with open(input_file, "r") as infile:
        with open(output_file, "w") as outfile:
            try:
                # Timeout scales with input size: 6h for LLM translators
                # (e.g. afriquegemma_llm at ~8s/sentence × 1012 ≈ 2.3h),
                # 2h for conventional MT backends.
                is_llm_translator = translator.startswith("afriquegemma")
                timeout_sec = 21600 if is_llm_translator else 7200
                # stderr=None allows real-time progress output
                result = subprocess.run(
                    cmd,
                    stdin=infile,
                    stdout=outfile,
                    stderr=None,
                    env=env,
                    check=True,
                    timeout=timeout_sec,
                    text=True
                )

            except subprocess.TimeoutExpired as e:
                elapsed_time = time.time() - start_time
                print(f"  ERROR: Translation timed out after {elapsed_time:.1f}s")
                raise

    elapsed_time = time.time() - start_time

    # Count output lines to verify completion
    with open(output_file, "r") as f:
        output_lines = sum(1 for _ in f if _.strip())

    print(f"  [COMPLETED at {time.strftime('%H:%M:%S')}]")
    print(f"  Output: {output_lines} lines (expected {input_lines})")

    if output_lines < input_lines:
        print(f"  WARNING: Output has fewer lines than input ({output_lines} < {input_lines})")
    elif output_lines > input_lines:
        print(f"  WARNING: Output has more lines than input ({output_lines} > {input_lines})")

    sys.stdout.flush()

    return elapsed_time


def calculate_bleu(reference_file, hypothesis_file):
    """Calculate BLEU score using sacrebleu"""
    with open(hypothesis_file, "r") as hyp:
        result = subprocess.run(
            [sys.executable, "-m", "sacrebleu", str(reference_file), "--score-only"],
            stdin=hyp,
            capture_output=True,
            text=True,
            check=True
        )
    return float(result.stdout.strip())


def calculate_chrfpp(reference_file, hypothesis_file):
    """Calculate chrF++ score using sacrebleu"""
    with open(hypothesis_file, "r") as hyp:
        result = subprocess.run(
            [sys.executable, "-m", "sacrebleu", str(reference_file), "-m", "chrf", "--chrf-word-order", "2", "--score-only"],
            stdin=hyp,
            capture_output=True,
            text=True,
            check=True
        )
    return float(result.stdout.strip())


def calculate_comet(source_file, reference_file, hypothesis_file):
    """Calculate COMET score using unbabel-comet"""
    try:
        from comet import download_model, load_from_checkpoint
        import torch
    except ImportError:
        raise ImportError("unbabel-comet is required for COMET evaluation. Install with: pip install unbabel-comet")

    # Disable MPS backend to avoid multiprocessing_context error on macOS
    # COMET library sets multiprocessing_context="fork" when MPS is available,
    # which conflicts with num_workers=0
    import os
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    if hasattr(torch.backends, 'mps'):
        torch.backends.mps.is_available = lambda: False

    # Read files
    with open(source_file, "r") as f:
        sources = [line.strip() for line in f]
    with open(reference_file, "r") as f:
        references = [line.strip() for line in f]
    with open(hypothesis_file, "r") as f:
        hypotheses = [line.strip() for line in f]

    # Prepare data for COMET
    data = [
        {"src": src, "mt": mt, "ref": ref}
        for src, mt, ref in zip(sources, hypotheses, references)
    ]

    # Load COMET model
    model_path = download_model("Unbabel/wmt22-comet-da")
    model = load_from_checkpoint(model_path)

    # Calculate score with CPU fallback (gpus=0 means CPU)
    # Explicitly set num_workers=0 to avoid multiprocessing_context error
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        result = model.predict(
            data,
            batch_size=8,
            gpus=0,
            num_workers=0,
            progress_bar=False,
            accelerator="cpu",
            devices=1
        )

    # Return system-level score (scaled to 0-100)
    return result.system_score * 100


def evaluate_pair(src_lang, trg_lang, translators, dataset_name, results_dir, data_dir, metrics=["bleu"], skip_existing=True, use_pivot=False, is_quantized_model=False, hyperparams=None, use_batch=False, max_samples=0):
    """Evaluate all translators for a language pair with multiple metrics

    Args:
        src_lang: Source language code
        trg_lang: Target language code
        translators: List of translator names to evaluate
        dataset_name: Name of the dataset to use
        results_dir: Directory to save results
        data_dir: Directory containing datasets
        metrics: List of metrics to calculate
        skip_existing: Whether to skip existing translations
        use_pivot: If True, use English as pivot for non-English pairs
        is_quantized_model: If True, then QVAC will try to use q4 gguf format model.
        hyperparams: Dictionary of hyperparameters (beamsize, lengthpenalty, etc.)
        use_batch: If True, use batch translation API (qvac_bergamot only)
        max_samples: Limit to first N sentences (0 = use all)
    """
    pair = (src_lang, trg_lang)
    pair_name = f"{src_lang}-{trg_lang}"

    metrics_str = ", ".join([m.upper() for m in metrics])
    print(f"\n{'='*60}")
    print(f"Evaluating {pair_name} on {dataset_name} with {metrics_str}")
    print(f"{'='*60}")

    # Copy dataset files
    src_file, trg_file = copy_dataset_files(dataset_name, src_lang, trg_lang, results_dir, data_dir)

    if max_samples > 0:
        n_src = truncate_file(src_file, max_samples)
        n_trg = truncate_file(trg_file, max_samples)
        print(f"  Truncated to {min(n_src, n_trg)} samples (--max-samples {max_samples})")

    # Define metric calculators
    metric_calculators = {}
    for metric in metrics:
        if metric == "bleu":
            metric_calculators[metric] = {
                "func": lambda ref, hyp: calculate_bleu(ref, hyp),
                "ext": "bleu",
                "name": "BLEU"
            }
        elif metric == "chrfpp":
            metric_calculators[metric] = {
                "func": lambda ref, hyp: calculate_chrfpp(ref, hyp),
                "ext": "chrfpp",
                "name": "chrF++"
            }
        elif metric == "comet":
            metric_calculators[metric] = {
                "func": lambda ref, hyp: calculate_comet(src_file, ref, hyp),
                "ext": "comet",
                "name": "COMET"
            }
        else:
            raise ValueError(f"Unknown metric: {metric}")

    results = {}

    for translator in translators:
        # Check if pair is supported
        supported = SUPPORTED_PAIRS.get(translator, set())
        if supported and pair not in supported:
            # If pivot translation is enabled and this is a non-English pair, check if pivot is possible
            if use_pivot and src_lang != "en" and trg_lang != "en":
                # Check if both src->en and en->trg are supported for pivot translation
                src_to_en = (src_lang, "en")
                en_to_trg = ("en", trg_lang)
                if src_to_en not in supported or en_to_trg not in supported:
                    print(f"\nSkipping {translator}: {pair_name} not supported (pivot via English also not supported)")
                    continue
                else:
                    print(f"\n{translator} will use pivot translation via English for {pair_name}")
            else:
                print(f"\nSkipping {translator}: {pair_name} not supported")
                continue

        print(f"\n--- {translator} ---")

        pair_dir = Path(results_dir) / pair_name
        hyp_file = pair_dir / f"{dataset_name}.{translator}.{trg_lang}"

        # Initialize results for this translator
        if translator not in results:
            results[translator] = {}

        try:
            # Count tokens for speed calculation (simple whitespace tokenization)
            num_tokens = 0
            with open(src_file, "r") as f:
                for line in f:
                    num_tokens += len(line.split())

            # Translate (skip if translation already exists)
            time_file = pair_dir / f"{dataset_name}.{translator}.{trg_lang}.time"
            perf_file = pair_dir / f"{dataset_name}.{translator}.{trg_lang}.perf"
            if not hyp_file.exists():
                elapsed_time = translate_file(translator, src_lang, trg_lang, src_file, hyp_file, use_pivot, is_quantized_model, hyperparams, use_batch)
                # Save timing
                with open(time_file, "w") as f:
                    f.write(f"{elapsed_time:.2f}\n")
                tokens_per_second = num_tokens / elapsed_time
                # Save performance (tok/s)
                with open(perf_file, "w") as f:
                    f.write(f"{tokens_per_second:.1f}\n")
                print(f"  Translation time: {elapsed_time:.2f}s ({tokens_per_second:.1f} tok/s)")
            else:
                print(f"  Using existing translation: {hyp_file}")
                # Load existing timing if available
                if time_file.exists():
                    with open(time_file, "r") as f:
                        elapsed_time = float(f.read().strip())
                    tokens_per_second = num_tokens / elapsed_time
                    # Save performance (tok/s) if not already saved
                    if not perf_file.exists():
                        with open(perf_file, "w") as f:
                            f.write(f"{tokens_per_second:.1f}\n")
                    print(f"  Translation time: {elapsed_time:.2f}s ({tokens_per_second:.1f} tok/s)")

            # Calculate all metrics on this translation
            for metric, calc_info in metric_calculators.items():
                score_file = pair_dir / f"{dataset_name}.{translator}.{trg_lang}.{calc_info['ext']}"

                # Check if already evaluated
                if skip_existing and score_file.exists():
                    with open(score_file, "r") as f:
                        score = float(f.read().strip())
                    print(f"  Already evaluated: {calc_info['name']} = {score:.2f}")
                    results[translator][metric] = score
                else:
                    # Calculate score
                    score = calc_info['func'](trg_file, hyp_file)

                    # Save score
                    with open(score_file, "w") as f:
                        f.write(f"{score:.1f}\n")

                    print(f"  {calc_info['name']} = {score:.2f}")
                    results[translator][metric] = score

        except Exception as e:
            print(f"  ERROR: {e}")
            traceback.print_exc()
            results[translator] = {metric: None for metric in metrics}

    # Print summary for each metric
    for metric in metrics:
        calc_info = metric_calculators[metric]
        print(f"\n{pair_name} Summary ({calc_info['name']}):")
        for translator, scores in results.items():
            score = scores.get(metric)
            if score is not None:
                print(f"  {translator:12s}: {score:5.2f}")
            else:
                print(f"  {translator:12s}: FAILED")

    return results


@click.command()
@click.option(
    "--pairs",
    required=True,
    help="Comma-separated language pairs (e.g., 'en-it,en-de')"
)
@click.option(
    "--translators",
    default="qvac,opusmt",
    help="Comma-separated translators: qvac,opusmt,google,nllb (default: qvac,opusmt)"
)
@click.option(
    "--dataset",
    default="flores-devtest",
    type=click.Choice(["flores-dev", "flores-devtest", "conversational-phrases"]),
    help="Dataset to use (default: flores-devtest)"
)
@click.option(
    "--metrics",
    default="bleu",
    help="Comma-separated evaluation metrics: bleu,chrfpp,comet (default: bleu)"
)
@click.option(
    "--results-dir",
    default="results",
    help="Directory to store results (default: results)"
)
@click.option(
    "--data-dir",
    default="data",
    help="Directory for Flores datasets (default: data)"
)
@click.option(
    "--skip-existing/--no-skip-existing",
    default=True,
    help="Skip already evaluated pairs (default: True)"
)
@click.option(
    "--use-pivot",
    is_flag=True,
    default=False,
    help="Use English as pivot language for non-English pairs (e.g., de-fr via de->en->fr)"
)
@click.option(
    "--is-quantized-model",
    is_flag=True,
    default=False,
    help="Use Quantized gguf format model supported with QVAC backend only"
)
@click.option(
    "--beamsize",
    default="4",
    help="Beam size for translation (1=greedy, 4=default)"
)
@click.option(
    "--lengthpenalty",
    default="1.0",
    help="Length penalty (0.0-2.0, default: 1.0)"
)
@click.option(
    "--repetitionpenalty",
    default="1.0",
    help="Repetition penalty (1.0-2.0, default: 1.0)"
)
@click.option(
    "--norepeatngramsize",
    default="0",
    help="No-repeat N-gram size (0-10, default: 0)"
)
@click.option(
    "--temperature",
    default="1.0",
    help="Sampling temperature (0.0-2.0, default: 1.0)"
)
@click.option(
    "--topk",
    default="0",
    help="Top-K sampling (0=disabled, default: 0)"
)
@click.option(
    "--topp",
    default="1.0",
    help="Top-P nucleus sampling (0.0-1.0, default: 1.0)"
)
@click.option(
    "--maxlength",
    default="512",
    help="Maximum output length (default: 512)"
)
@click.option(
    "--batch",
    is_flag=True,
    default=False,
    help="Use batch translation API for qvac_bergamot (faster for multiple texts)"
)
@click.option(
    "--max-samples",
    default=0,
    type=int,
    help="Limit evaluation to first N samples (0 = all, default: 0)"
)
def main(pairs, translators, dataset, metrics, results_dir, data_dir, skip_existing, use_pivot, is_quantized_model, beamsize, lengthpenalty, repetitionpenalty, norepeatngramsize, temperature, topk, topp, maxlength, batch, max_samples):
    """Translation Quality Evaluation Framework

    Examples:

      # Evaluate QVAC vs OpusMT on en-it with BLEU
      python evaluate.py --pairs en-it --translators qvac,opusmt

      # Evaluate with multiple metrics
      python evaluate.py --pairs en-it --translators qvac,opusmt --metrics bleu,chrfpp,comet

      # Evaluate all translators on multiple pairs
      python evaluate.py --pairs en-it,en-de,de-en --translators qvac,opusmt,nllb

      # Use Flores-dev dataset
      python evaluate.py --pairs en-it --dataset flores-dev
      
      # Use English as pivot for non-English pairs (works with all translators)
      python evaluate.py --pairs de-fr --translators qvac,opusmt,google,nllb --use-pivot

      # Use for lang-English or English-lang pairs with GGUF q4_0 models (works with qvac only) 
      python evaluate.py --pairs de-fr --translators qvac --is-quantized-model

      # Use batch translation API for faster processing (works with qvac_bergamot only)
      python evaluate.py --pairs en-de --translators qvac_bergamot --batch

      # Evaluate AfriqueGemma LLM on first 30 samples with chrF++
      python evaluate.py --pairs en-sw --translators afriquegemma_llm --metrics chrfpp --max-samples 30
    """
    # Parse pairs
    pair_list = []
    for pair_str in pairs.split(","):
        pair_str = pair_str.strip()
        if "-" not in pair_str or len(pair_str) != 5:
            print(f"ERROR: Invalid pair format '{pair_str}'. Expected format: 'en-it'")
            sys.exit(1)
        src, trg = pair_str.split("-")
        pair_list.append((src, trg))

    # Parse translators
    translator_list = [t.strip() for t in translators.split(",")]

    # Parse metrics
    metric_list = [m.strip() for m in metrics.split(",")]
    valid_metrics = ["bleu", "chrfpp", "comet"]
    for metric in metric_list:
        if metric not in valid_metrics:
            print(f"ERROR: Invalid metric '{metric}'. Valid metrics: {', '.join(valid_metrics)}")
            sys.exit(1)

    # Parse hyperparameters
    hyperparams = {
        "beamsize": int(beamsize),
        "lengthpenalty": float(lengthpenalty),
        "repetitionpenalty": float(repetitionpenalty),
        "norepeatngramsize": int(norepeatngramsize),
        "temperature": float(temperature),
        "topk": int(topk),
        "topp": float(topp),
        "maxlength": int(maxlength)
    }

    print("Translation Quality Evaluation")
    print(f"  Dataset: {dataset}")
    print(f"  Metrics: {', '.join([m.upper() for m in metric_list])}")
    print(f"  Pairs: {', '.join(f'{s}-{t}' for s, t in pair_list)}")
    print(f"  Translators: {', '.join(translator_list)}")
    print(f"  Results dir: {results_dir}")
    print(f"  Data dir: {data_dir}")
    if use_pivot:
        print(f"  Pivot mode: ENABLED (using English as pivot for non-English pairs)")
    else:
        print(f"  Pivot mode: DISABLED (using direct translation)")

    if (is_quantized_model):
        print(f" Use of quantized model only with GGUF format and QVAC backend")
    else:
        print(f" Use of default models- first f16, then f32 if f16 is not avialable locally")

    print(f"  Hyperparameters: beam={hyperparams['beamsize']}, length_penalty={hyperparams['lengthpenalty']}, repetition_penalty={hyperparams['repetitionpenalty']}, no_repeat_ngram={hyperparams['norepeatngramsize']}, temp={hyperparams['temperature']}, topk={hyperparams['topk']}, topp={hyperparams['topp']}, maxlen={hyperparams['maxlength']}")

    if batch:
        print(f"  Batch mode: ENABLED (qvac_bergamot only)")
    else:
        print(f"  Batch mode: DISABLED")

    if max_samples > 0:
        print(f"  Max samples: {max_samples}")

    # Download dataset if needed
    download_dataset(data_dir, dataset)

    # Evaluate each pair
    all_results = {}
    for src, trg in pair_list:
        results = evaluate_pair(
            src, trg,
            translator_list,
            dataset,
            results_dir,
            data_dir,
            metric_list,
            skip_existing,
            use_pivot,
            is_quantized_model,
            hyperparams,
            batch,
            max_samples
        )
        all_results[f"{src}-{trg}"] = results

    # Final summary
    print(f"\n{'='*60}")
    print("FINAL SUMMARY")
    print(f"{'='*60}")

    for pair_name, results in all_results.items():
        print(f"\n{pair_name}:")
        for translator, scores in results.items():
            score_strs = []
            for metric in metric_list:
                score = scores.get(metric)
                if score is not None:
                    score_strs.append(f"{metric.upper()}={score:5.2f}")
                else:
                    score_strs.append(f"{metric.upper()}=FAILED")
            print(f"  {translator:12s}: {', '.join(score_strs)}")

    print(f"\nResults saved to: {results_dir}")


if __name__ == "__main__":
    main()
