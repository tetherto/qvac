import re
from datetime import datetime
from pathlib import Path
from iso639 import Lang
from src.marian.config import Config
from src.marian.client import TranslationResults


def _get_results_root() -> Path:
    """
    Find the project root by climbing up from this file, and then
    return the `benchmarks/results/` dir under it.
    """
    project_root = Path(__file__).resolve().parents[3]
    results_root = project_root / "results"
    results_root.mkdir(parents=True, exist_ok=True)
    return results_root


def save_benchmark_results(
    cfg: Config,
    bleu_score: float,
    comet_score: float,
    xcomet_score: float | None,
    results: TranslationResults,
    notes: str = None,
):
    """
    Save individual benchmark results to a markdown file under benchmarks/results/marian/<quantization>/
    """
    results_root = _get_results_root()

    src = Lang(cfg.dataset.src_lang.split("_")[0]).pt1
    dst = Lang(cfg.dataset.dst_lang.split("_")[0]).pt1
    # Since lib and version are no longer in config, we use a default naming
    config_name = f"{src}-{dst}"

    # Create results folder
    results_dir = results_root / "marian"
    results_dir.mkdir(parents=True, exist_ok=True)

    md_path = results_dir / f"{config_name}.md"

    addon_info = f"QVAC SDK v{results.model_version}"
    notes = notes or f"Performed on GPU"

    lines = [
        f"# Benchmark Results for {config_name}",
        "",
        f"**Addon:** {addon_info}",
        "",
        f"**Model ID:** {cfg.server.model_id}",
        "",
        f"**Hyperdrive Key:** {cfg.server.hyperdrive_key}",
        "",
        "**Dataset:** Flores+",
        "",
        "## Scores",
        f"- **BLEU:** {bleu_score:.2f}",
        f"- **COMET:** {comet_score:.2f}",
    ]
    if xcomet_score is not None:
        lines.append(f"- **XCOMET:** {xcomet_score:.2f}")
    lines += [
        "",
        "## Performance",
        f"- **Total load time:** {results.total_load_time_ms:.2f} ms",
        f"- **Total run time:** {results.total_run_time_ms:.2f} ms",
        "",
        "## Notes",
        f"- {notes}",
    ]

    md_path.write_text("\n".join(lines), encoding="utf-8")

def generate_summary():
    """
    Scan benchmarks/results/marian/src-target.md files
    and rewrite benchmarks/results/marian/results_summary.md as one aggregated table
    """
    results_root = _get_results_root()
    marian_results_root = results_root / "marian"
    summary_path = marian_results_root / "results_summary.md"

    # Find all markdown files directly in the marian results directory
    md_files = sorted(marian_results_root.glob("*.md"))
    
    out = [
        "# Aggregated Benchmark Results",
        "",
        "This summary consolidates benchmarking results across all language pairs using QVAC SDK.",
        "",
        "Original Model: [MarianMT](https://huggingface.co/docs/transformers/en/model_doc/marian#marianmt)",
        "",
        "| Src lang | Dest lang | SDK Version | Model ID | Hyperdrive Key | COMET | BLEU | Dataset | Notes |",
        "|----------|-----------|-------------|----------|----------------|-------|------|---------|-------|",
    ]

    for md_file in md_files:
        if md_file.name == "results_summary.md":
            continue  # Skip the summary file itself
            
        text = md_file.read_text(encoding="utf-8")
        stem = md_file.stem

        # Parse src-dest from filename
        parts = stem.split("-")
        if len(parts) != 2:
            continue
        src, dest = parts

        # Parse addon info: "QVAC SDK v1.2.3"
        addon_m = re.search(r"\*\*Addon:\*\*\s*QVAC SDK v([^\n]+)", text)
        version = addon_m.group(1).strip() if addon_m else "unknown"

        # Parse model ID
        model_id_m = re.search(r"\*\*Model ID:\*\*\s*([^\n]+)", text)
        model_id = model_id_m.group(1).strip() if model_id_m else "unknown"

        # Parse hyperdrive key
        hd_key_m = re.search(r"\*\*Hyperdrive Key:\*\*\s*([^\n]+)", text)
        hd_key = hd_key_m.group(1).strip() if hd_key_m else "unknown"

        # Dataset
        ds_m = re.search(r"\*\*Dataset:\*\*\s*([^\n]+)", text)
        dataset = ds_m.group(1).strip() if ds_m else ""

        # Scores
        bleu_m = re.search(r"- \*\*BLEU:\*\*\s*([\d\.]+)", text)
        comet_m = re.search(r"- \*\*COMET:\*\*\s*([\d\.]+)", text)
        bleu = bleu_m.group(1) if bleu_m else ""
        comet = comet_m.group(1) if comet_m else ""

        # Notes
        notes_m = re.search(r"## Notes\s*\n- (.+)", text)
        notes = notes_m.group(1).strip() if notes_m else ""

        # Append the row
        out.append(
            f"| {src} | {dest} | {version} | {model_id} | {hd_key} | {comet} | {bleu} | {dataset} | {notes} |"
        )

    out += [
        "",
        "## Reference",
        "",
        "### COMET (Crosslingual Optimized Metric for Evaluation of Translation)",
        "",
        "A modern neural metric trained to match human judgments. Most useful for capturing semantic adequacy, especially for low-resource or morphologically rich languages.",
        "",
        "Range: 0 - 1, **Higher = better**",
        "",
        "| **Score Range** | **Interpretation** |",
        "|----------------|--------------------|",
        "| 0.75 - 1      | Human-parity or better; stylistic variations only |",
        "| 0.60 - 0.75   | High-quality MT; minor or rare issues |",
        "| 0.40 - 0.60   | Adequate; understandable but potentially error-prone |",
        "| < 0.40       | Low quality; meaning often lost or garbled |",
        "",
        "### BLEU (Bilingual Evaluation Understudy)",
        "",
        "A traditional MT quality metric based on n-gram overlap between model output and reference translations. Most useful for comparing models on the same domain and dataset. Less sensitive to subtle meaning shifts.",
        "",
        "Range: 0 - 100, **Higher = better**",
        "",
        "| **Score Range** | **Interpretation** |",
        "|----------------|--------------------|",
        "| > 50           | Excellent; near human quality, minimal post-editing needed |",
        "| 30 - 50        | Adequate; understandable but with notable errors |",
        "| < 30           | Weak; major issues in grammar, fluency, or meaning |",
        "",
    ]

    summary_path.write_text("\n".join(out), encoding="utf-8")
