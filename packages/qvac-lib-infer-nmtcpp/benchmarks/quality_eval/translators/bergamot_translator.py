"""
Bergamot Translator wrapper for evaluation framework
Uses bergamot-translator Python package with local model management.
Auto-downloads Firefox Translations models from Mozilla CDN when not found locally.
"""

import os
import sys
import json
import gzip
import shutil
from urllib.request import urlopen, Request
from tqdm import tqdm
import toolz
from pathlib import Path
import subprocess

try:
    import bergamot
except ImportError:
    print("ERROR: bergamot package not found. Install with: python3.10 -m pip install bergamot", file=sys.stderr)
    print("Note: Requires Python 3.10 or earlier", file=sys.stderr)
    sys.exit(1)

# Firefox translations models directory (can be overridden via env var)
FIREFOX_MODELS_DIR = os.environ.get("FIREFOX_MODELS_DIR", Path.home() / ".local/share/bergamot/models/firefox")


FIREFOX_RECORDS_URL = (
    "https://firefox.settings.services.mozilla.com/v1/"
    "buckets/main/collections/translations-models/records"
)
FIREFOX_ATTACHMENT_BASE = (
    "https://firefox-settings-attachments.cdn.mozilla.net"
)


def download_firefox_model(src_lang, trg_lang):
    """Download Firefox Translations model files from Mozilla CDN.

    Fetches model, vocab and lex files for a language pair from the
    same Remote Settings CDN that Firefox uses internally.

    Returns:
        Path to model directory if successful, None otherwise
    """
    print(f"[bergamot] Downloading model {src_lang}-{trg_lang} from Firefox CDN...", file=sys.stderr)

    try:
        req = Request(FIREFOX_RECORDS_URL, headers={"User-Agent": "qvac-eval/1.0"})
        with urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
        records = body.get("data", [])
    except Exception as e:
        print(f"[bergamot] Failed to fetch Firefox model records: {e}", file=sys.stderr)
        return None

    pair_records = [
        r for r in records
        if r.get("fromLang") == src_lang and r.get("toLang") == trg_lang and r.get("attachment")
    ]

    if not pair_records:
        print(f"[bergamot] No Firefox model found for {src_lang}-{trg_lang}", file=sys.stderr)
        return None

    pair_code = f"{src_lang}{trg_lang}"
    dest_dir = Path(FIREFOX_MODELS_DIR) / "base-memory" / pair_code
    dest_dir.mkdir(parents=True, exist_ok=True)

    for record in pair_records:
        att = record.get("attachment", {})
        location = att.get("location")
        if not location:
            continue

        filename = record.get("name") or att.get("filename") or Path(location).name
        url = f"{FIREFOX_ATTACHMENT_BASE}/{location}"
        dest_path = dest_dir / filename

        print(f"[bergamot]   Downloading {filename}...", file=sys.stderr)
        try:
            req = Request(url, headers={"User-Agent": "qvac-eval/1.0"})
            with urlopen(req, timeout=120) as resp:
                data = resp.read()
            dest_path.write_bytes(data)
            size_mb = len(data) / 1024 / 1024
            print(f"[bergamot]   ✓ {filename} ({size_mb:.1f}MB)", file=sys.stderr)
        except Exception as e:
            print(f"[bergamot]   ✗ Failed to download {filename}: {e}", file=sys.stderr)
            return None

    # Verify we got the essential files
    files = list(dest_dir.iterdir())
    has_model = any(f.name.endswith(".bin") and "intgemm" in f.name for f in files)
    has_vocab = any(f.name.endswith(".spm") for f in files)

    if has_model and has_vocab:
        print(f"[bergamot] Download complete → {dest_dir}", file=sys.stderr)
        return dest_dir
    else:
        print(f"[bergamot] Download incomplete — missing model or vocab files", file=sys.stderr)
        return None


def check_firefox_model(src_lang, trg_lang):
    """Check if Firefox translations model exists for this language pair

    Returns:
        Path to config file if found, None otherwise
    """
    pair_code = f"{src_lang}{trg_lang}"
    firefox_dir = Path(FIREFOX_MODELS_DIR)

    # Try base-memory first, then fall back to tiny
    model_dir = None
    for variant in ["base-memory", "tiny"]:
        candidate_dir = firefox_dir / variant / pair_code
        if candidate_dir.exists():
            # Check for required Firefox model files
            model_file = candidate_dir / f"model.{pair_code}.intgemm.alphas.bin"
            lex_file = candidate_dir / f"lex.50.50.{pair_code}.s2t.bin"

            # Check for vocab files - some pairs have single vocab, others have src/trg vocabs
            vocab_file = candidate_dir / f"vocab.{pair_code}.spm"
            srcvocab_file = candidate_dir / f"srcvocab.{pair_code}.spm"
            trgvocab_file = candidate_dir / f"trgvocab.{pair_code}.spm"

            has_vocab = vocab_file.exists() or (srcvocab_file.exists() and trgvocab_file.exists())

            if model_file.exists() and has_vocab and lex_file.exists():
                model_dir = candidate_dir
                print(f"Found Firefox model in {variant}: {pair_code}", file=sys.stderr)
                break

    if model_dir is None:
        return None

    # Model files paths
    model_file = model_dir / f"model.{pair_code}.intgemm.alphas.bin"
    lex_file = model_dir / f"lex.50.50.{pair_code}.s2t.bin"

    # Determine which vocab files to use
    vocab_file = model_dir / f"vocab.{pair_code}.spm"
    srcvocab_file = model_dir / f"srcvocab.{pair_code}.spm"
    trgvocab_file = model_dir / f"trgvocab.{pair_code}.spm"

    # Create or use existing bergamot config
    config_path = model_dir / "config.bergamot.yml"

    if config_path.exists():
        return config_path

    # Determine which vocab files to use in config
    if srcvocab_file.exists() and trgvocab_file.exists():
        # Use separate source and target vocabularies (e.g., for en-ja, en-ko, en-zh)
        src_vocab_path = srcvocab_file
        trg_vocab_path = trgvocab_file
        print(f"Using separate vocabularies: {srcvocab_file.name}, {trgvocab_file.name}", file=sys.stderr)
    else:
        # Use shared vocabulary (most language pairs)
        src_vocab_path = vocab_file
        trg_vocab_path = vocab_file
        print(f"Using shared vocabulary: {vocab_file.name}", file=sys.stderr)

    # Create config file for Firefox model
    print(f"Creating bergamot config for Firefox model: {config_path}", file=sys.stderr)
    config_content = f"""models:
  - {model_file}
vocabs:
  - {src_vocab_path}
  - {trg_vocab_path}
shortlist:
    - {lex_file}
    - false
beam-size: 1
normalize: 1.0
word-penalty: 0
max-length-break: 128
mini-batch-words: 1024
mini-batch: 64
workspace: 128
alignment: soft
max-length-factor: 2.5
gemm-precision: int8shiftAlphaAll
"""
    config_path.write_text(config_content)
    return config_path


def translate_direct(texts, src_lang, trg_lang):
    """Translates texts directly from source to target language using Bergamot

    Args:
        texts: List of strings to translate
        src_lang: Source language code (e.g., "en", "de")
        trg_lang: Target language code (e.g., "de", "en")

    Returns:
        List of translated strings
    """
    # Check for Firefox model
    config_path = check_firefox_model(src_lang, trg_lang)

    if config_path is None:
        # Auto-download from Firefox CDN
        print(f"Model not found locally, attempting Firefox CDN download...", file=sys.stderr)
        dl_dir = download_firefox_model(src_lang, trg_lang)
        if dl_dir:
            config_path = check_firefox_model(src_lang, trg_lang)

    if config_path is None:
        print(f"ERROR: Firefox translations model not found for {src_lang}-{trg_lang}", file=sys.stderr)
        print(f"Checked: {Path(FIREFOX_MODELS_DIR) / 'base-memory' / f'{src_lang}{trg_lang}'}", file=sys.stderr)
        print(f"Checked: {Path(FIREFOX_MODELS_DIR) / 'tiny' / f'{src_lang}{trg_lang}'}", file=sys.stderr)
        print(f"Returning empty translations", file=sys.stderr)
        return [""] * len(texts)

    print(f"Using Firefox translations model: {src_lang}-{trg_lang}", file=sys.stderr)

    # Create service and load model
    service_config = bergamot.ServiceConfig(numWorkers=4, logLevel="off")
    service = bergamot.Service(service_config)

    try:
        model = service.modelFromConfigPath(str(config_path))
    except Exception as e:
        print(f"ERROR: Failed to load bergamot model from {config_path}: {e}", file=sys.stderr)
        print(f"Returning empty translations", file=sys.stderr)
        return [""] * len(texts)

    # Configure response options
    options = bergamot.ResponseOptions(
        alignment=False,
        qualityScores=False,
        HTML=False
    )

    # Translate in batches
    results = []
    batch_size = 10  # Process 10 sentences at a time

    for partition in tqdm(list(toolz.partition_all(batch_size, texts)), desc=f"Bergamot {src_lang}->{trg_lang}"):
        # Convert partition to VectorString
        input_texts = bergamot.VectorString(list(partition))

        # Translate
        responses = service.translate(model, input_texts, options)

        # Extract translated text from responses
        for response in responses:
            results.append(response.target.text.strip())

    return results


def translate_pivot(texts, src_lang, trg_lang):
    """Translates texts via English pivot (src -> en -> trg) using Bergamot

    Args:
        texts: List of strings to translate
        src_lang: Source language code
        trg_lang: Target language code

    Returns:
        List of translated strings
    """
    print(f"Performing Bergamot pivot translation: {src_lang} -> en -> {trg_lang}", file=sys.stderr)

    # Get config paths for both models (Firefox only)
    config_path_1 = check_firefox_model(src_lang, "en")
    config_path_2 = check_firefox_model("en", trg_lang)

    # Auto-download missing models from Firefox CDN
    if config_path_1 is None:
        print(f"Model not found for {src_lang}->en, attempting Firefox CDN download...", file=sys.stderr)
        dl_dir = download_firefox_model(src_lang, "en")
        if dl_dir:
            config_path_1 = check_firefox_model(src_lang, "en")

    if config_path_2 is None:
        print(f"Model not found for en->{trg_lang}, attempting Firefox CDN download...", file=sys.stderr)
        dl_dir = download_firefox_model("en", trg_lang)
        if dl_dir:
            config_path_2 = check_firefox_model("en", trg_lang)

    if config_path_1 is None:
        print(f"ERROR: Firefox model not found for {src_lang}->en", file=sys.stderr)
        print(f"Checked: {Path(FIREFOX_MODELS_DIR) / 'base-memory' / f'{src_lang}en'}", file=sys.stderr)
        print(f"Checked: {Path(FIREFOX_MODELS_DIR) / 'tiny' / f'{src_lang}en'}", file=sys.stderr)
        return [""] * len(texts)

    if config_path_2 is None:
        print(f"ERROR: Firefox model not found for en->{trg_lang}", file=sys.stderr)
        print(f"Checked: {Path(FIREFOX_MODELS_DIR) / 'base-memory' / f'en{trg_lang}'}", file=sys.stderr)
        print(f"Checked: {Path(FIREFOX_MODELS_DIR) / 'tiny' / f'en{trg_lang}'}", file=sys.stderr)
        return [""] * len(texts)

    print(f"Using Firefox model for {src_lang}->en", file=sys.stderr)
    print(f"Using Firefox model for en->{trg_lang}", file=sys.stderr)

    # Create service and load both models
    service_config = bergamot.ServiceConfig(numWorkers=4, logLevel="off")
    service = bergamot.Service(service_config)

    try:
        model_1 = service.modelFromConfigPath(str(config_path_1))
        model_2 = service.modelFromConfigPath(str(config_path_2))
    except Exception as e:
        print(f"ERROR: Failed to load bergamot models: {e}", file=sys.stderr)
        print(f"Returning empty translations", file=sys.stderr)
        return [""] * len(texts)

    # Configure response options
    options = bergamot.ResponseOptions(
        alignment=False,
        qualityScores=False,
        HTML=False
    )

    # Translate in batches using pivot
    results = []
    batch_size = 10

    for partition in tqdm(list(toolz.partition_all(batch_size, texts)), desc=f"Bergamot pivot {src_lang}->en->{trg_lang}"):
        # Convert partition to VectorString
        input_texts = bergamot.VectorString(list(partition))

        # Pivot translate (src -> en -> trg)
        responses = service.pivot(model_1, model_2, input_texts, options)

        # Extract translated text from responses
        for response in responses:
            results.append(response.target.text.strip())

    return results


def translate(texts):
    """Main translation function that decides between direct and pivot translation

    Args:
        texts: List of strings to translate

    Returns:
        List of translated strings
    """
    source = os.environ["SRC"]
    target = os.environ["TRG"]
    use_pivot = os.environ.get("USE_PIVOT", "false").lower() == "true"

    # Check if we should use pivot translation
    if use_pivot and source != "en" and target != "en":
        # Use pivot translation via English
        return translate_pivot(texts, source, target)
    else:
        # Use direct translation
        return translate_direct(texts, source, target)


if __name__ == "__main__":
    # Read from stdin, translate, write to stdout
    # This is used by the evaluation framework
    texts = [line.strip() for line in sys.stdin]

    if not texts:
        sys.exit(0)

    translations = translate(texts)

    sys.stdout.write("\n".join(translations))
    sys.stdout.write("\n")
