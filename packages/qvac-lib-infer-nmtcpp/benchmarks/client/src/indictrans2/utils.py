import re
from pathlib import Path
from src.indictrans2.config import Config
from src.indictrans2.client import TranslationResults


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
    notes: str = None):
    """
    Save individual benchmark results to a markdown file under benchmarks/results/indictrans2/<quantization>/
    """
    results_root = _get_results_root()

    src = cfg.dataset.src_lang
    dst = cfg.dataset.dst_lang
    addon = cfg.server.lib
    addonInfo = addon.rsplit("-", 2)
    modelType = addonInfo[1]
    quant = addonInfo[2]
    config_name = f"{src}-{dst}-{modelType}-{quant}"

    # Create quantization folder
    quant_dir = results_root / "indictrans2" / quant
    quant_dir.mkdir(parents=True, exist_ok=True)

    md_path = quant_dir / f"{config_name}.md"

    addon_info = f'"{addon}": "{cfg.server.version}"'
    notes = notes or f"Performed on GPU"

    lines = [
        f"# Benchmark Results for {config_name}",
        "",
        f"**Addon:** {addon_info}",
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
    Scan benchmarks/results/indictrans2/<quantization>/src-target-quantization.md
    and rewrite benchmarks/results/indictrans2/results_summary.md as one aggregated table
    """
    results_root = _get_results_root()
    indictrans_results_root = results_root / "indictrans2"
    summary_path = results_root / "indictrans2" / "results_summary.md"

    quant_dirs = sorted(
        d for d in indictrans_results_root.iterdir() if d.is_dir() and not d.name.startswith(".")
    )

    out = [
        "# Aggregated Benchmark Results",
        "",
        "This summary consolidates benchmarking results across all quantizations and language pairs.",
        "",
        "| Src lang | Dest lang | Quantization | Version | Model | COMET | BLEU | Dataset | Notes |",
        "|----------|-----------|--------------|---------|-------|--------|--------|---------|-------|",
    ]

    for quant_dir in quant_dirs:
        quant = quant_dir.name
        for md_file in sorted(quant_dir.glob("*.md")):
            text = md_file.read_text(encoding="utf-8")
            stem = md_file.stem

            parts = stem.split("-")
            src, dest, modelType, file_quant = parts
            addon_m = re.search(
                r"\*\*Addon:\*\*\s*\"([^\"]+)\"\s*:\s*\"([^\"]+)\"", text
            )
            addon_id = addon_m.group(1) if addon_m else ""
            version = addon_m.group(2) if addon_m else ""

            # derive model name from addon_id (strip prefix up through mlc- and suffix -quant)
            model = ""
            if addon_id:
                mmod = re.search(r"mlc-([^-]+(?:-[^-]+)*)-" + re.escape(quant), addon_id)
                model = mmod.group(1) if mmod else addon_id

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
                f"| {src} | {dest} | {quant} | {version} | {model} | {comet} | {bleu} | {dataset} | {notes} |"
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

