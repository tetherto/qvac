import re
from pathlib import Path
from src.whisper.config import Config
from src.whisper.client import AddonResult


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
    wer_score: float,
    cer_score: float,
    results: AddonResult,
    notes: str = None,
):
    """
    Save individual benchmark results to a markdown file under benchmarks/results/<quantization>/
    """
    results_root = _get_results_root()

    addon = cfg.server.lib
    speaker_group = cfg.dataset.speaker_group.value
    variant = addon.rsplit("-", 2)[-2]
    quant = addon.rsplit("-", 1)[-1]
    vad_status = "vad" if cfg.vad.enabled else "no_vad"
    config_name = f"{speaker_group}-{variant}-{quant}-{vad_status}"

    # Create quantization folder
    quant_dir = results_root / quant
    quant_dir.mkdir(parents=True, exist_ok=True)

    md_path = quant_dir / f"{config_name}.md"

    addon_info = f'"{addon}": "{cfg.server.version}"'
    vad_info = f'"{cfg.vad.lib}": "{cfg.vad.version}"' if cfg.vad.enabled else "N/A"
    notes = notes or f"Performed on GPU"

    lines = [
        f"# Benchmark Results for {config_name}",
        "",
        f"**Addon:** {addon_info}",
        "",
        f"**VAD:** {vad_info}",
        "",
        "**Dataset:** Librispeech",
        "",
        f"**Speaker group:** {speaker_group}",
        "",
        "## Scores",
        f"- **WER:** {wer_score:.2f}",
        f"- **CER:** {cer_score:.2f}",
    ]
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
    Scan all result files in benchmarks/results/<quantization>/ and rewrite results_summary.md
    """
    results_root = _get_results_root()
    summary_path = results_root / "results_summary.md"

    quant_dirs = [
        d for d in results_root.iterdir() if d.is_dir() and not d.name.startswith(".")
    ]

    out = [
        "# Aggregated Benchmark Results",
        "",
        "This summary consolidates benchmarking results across all quantizations and speaker groups.",
        "",
        "Original Model: [Whisper-Tiny](https://huggingface.co/openai/whisper-tiny)",
        "",
        "| Speaker group | Quantization | Version | Model | VAD | WER | CER | Dataset | Notes |",
        "|---------------|--------------|---------|-------|-----|-----|-----|---------|-------|",
    ]
    
    vad_version = None
    vad_lib = None

    for quant_dir in sorted(quant_dirs):
        quant = quant_dir.name
        for md_file in sorted(quant_dir.glob("*.md")):
            text = md_file.read_text(encoding="utf-8")
            stem = md_file.stem

            parts = stem.split("-")
            if len(parts) != 4:
                continue
            speaker_group, variant, file_quant, vad_status = parts
            if file_quant != quant:
                raise ValueError(
                    f"Quantization mismatch: {file_quant} != {quant} in {md_file}"
                )
            addon_m = re.search(
                r"\*\*Addon:\*\*\s*\"([^\"]+)\"\s*:\s*\"([^\"]+)\"", text
            )
            addon_id = addon_m.group(1) if addon_m else ""
            version = addon_m.group(2) if addon_m else ""

            vad_m = re.search(
                r"\*\*VAD:\*\*\s*(?:N/A|\"([^\"]+)\"\s*:\s*\"([^\"]+)\")", text
            )
            vad_lib = "N/A" if not vad_m or "N/A" in vad_m.group(0) else vad_m.group(1)
            vad_version = (
                vad_m.group(2) if vad_m and "N/A" not in vad_m.group(0) else ""
            )

            # Add VAD status indicator
            vad_status = "✓" if vad_lib != "N/A" else "-"

            # derive model name from addon_id (strip prefix up through mlc- and suffix -quant)
            model = ""
            if addon_id:
                mmod = re.search(r"mlc-([^-]+-[^-]+)-" + re.escape(quant), addon_id)
                model = mmod.group(1) if mmod else addon_id

            # Dataset
            ds_m = re.search(r"\*\*Dataset:\*\*\s*([^\n]+)", text)
            dataset = ds_m.group(1).strip() if ds_m else ""

            # Scores
            wer_m = re.search(r"- \*\*WER:\*\*\s*([\d\.]+)", text)
            cer_m = re.search(r"- \*\*CER:\*\*\s*([\d\.]+)", text)
            wer = wer_m.group(1) if wer_m else ""
            cer = cer_m.group(1) if cer_m else ""

            # Notes
            notes_m = re.search(r"## Notes\s*\n- (.+)", text)
            notes = notes_m.group(1).strip() if notes_m else ""

            # Append the row
            out.append(
                f"| {speaker_group} | {quant} | {version} | {model} | {vad_status} | {wer} | {cer} | {dataset} | {notes} |"
            )

    out += [
        "",
        "## Reference",
        "",
        "### WER (Word Error Rate)",
        "",
        "Measures the fraction of word-level substitutions, deletions, and insertions vs. a reference transcription",
        "",
        "Range: 0 – 100, **Lower = better**",
        "",
        "| **Score Range** | **Interpretation** |",
        "|----------------|--------------------|",
        "| 0 – 5   | Excellent; near human-parity transcription |",
        "| 5 – 15  | High quality; minor word errors |",
        "| 15 – 30 | Adequate; understandable but noticeable mistakes |",
        "| > 30    | Low quality; transcript often unreliable |",
        "",
        "### CER (Character Error Rate)",
        "",
        "Same formula as WER but computed on characters instead of words",
        "",
        "Range: 0 – 100, **Lower = better**",
        "",
        "| **Score Range** | **Interpretation** |",
        "|----------------|--------------------|",
        "| 0 – 2   | Excellent; virtually no character errors |",
        "| 2 – 10  | High quality; few character mistakes |",
        "| 10 – 20 | Adequate; visible errors that may need correction |",
        "| > 20    | Low quality; many character errors |",
        "",
        "### Speaker Group",
        "",
        "The speaker group is a classification introduced by the LibriSpeech authors, who automatically ranked speakers based on the WER from a WSJ-trained ASR model applied to their recordings.",
        "",
        "| Speaker Group | Description |",
        "|---------------|-------------|",
        "| clean         | Speakers with **lower WER** |",
        "| other         | Speakers with **higher WER** |",
        "| all           | Full corpus: both *clean* and *other* segments combined. |",
        "",
        "### VAD (Voice Activity Detection)",
        "",
        "VAD is a technique used to identify and separate speech from non-speech segments in audio. It is often used in speech recognition systems to improve accuracy by reducing the impact of background noise and other non-speech sounds.",
        "",
        f"Addon: {vad_lib}",
        "",
        f"Version: {vad_version}",
        "",
        "| VAD | Description |",
        "|-----|-------------|",
        "| ✓   | VAD is enabled |",
        "| -   | VAD is disabled |",
        "",
    ]

    summary_path.write_text("\n".join(out), encoding="utf-8")
