import re
from pathlib import Path
from src.whisper.config import Config
from src.whisper.client import AddonResults


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
    results: AddonResults,
    notes: str = None,
    aradiawer_details: dict = None,
):
    """
    Save individual benchmark results to a markdown file under benchmarks/results/<quantization>/
    
    Args:
        cfg: Configuration object
        wer_score: Word Error Rate score
        cer_score: Character Error Rate score
        results: Transcription results from the addon
        notes: Optional notes to include
        aradiawer_details: Optional dict with AraDiaWER metrics for Arabic:
            - aradiawer: AraDiaWER score
            - semantic_score: Semantic similarity score
            - syntactic_score: Syntactic similarity score
    """
    results_root = _get_results_root()

    addon = cfg.server.lib
    dataset_type = cfg.dataset.dataset_type.value
    speaker_group = cfg.dataset.speaker_group.value
    language = cfg.dataset.language.value
    
    model_file = cfg.model.path.split("/")[-1]
    model_name = model_file.replace(".bin", "")
    
    vad_status = "vad" if cfg.model.vad_model_path else "no_vad"
    streaming_status = "streaming" if cfg.model.streaming else "batch"
    config_name = f"{dataset_type}-{language}-{speaker_group}-{model_name}-{vad_status}-{streaming_status}"

    model_dir = results_root / model_name
    model_dir.mkdir(parents=True, exist_ok=True)

    md_path = model_dir / f"{config_name}.md"

    addon_info = f'"{addon}": "{cfg.server.version}"'
    vad_info = "Built-in (enabled)" if cfg.model.vad_model_path else "Built-in (disabled)"
    streaming_info = "Enabled" if cfg.model.streaming else "Disabled"
    notes = notes or f"Performed on GPU"
    num_samples = len(results.transcriptions)

    lines = [
        f"# Benchmark Results for {config_name}",
        "",
        f"**Addon:** {addon_info}",
        "",
        f"**VAD:** {vad_info}",
        "",
        f"**Streaming Mode:** {streaming_info}",
        "",
        f"**Dataset:** {dataset_type.capitalize()}",
        "",
        f"**Language:** {language}",
        "",
        f"**Speaker group:** {speaker_group}",
        "",
        f"**Samples evaluated:** {num_samples}",
        "",
        "## Scores",
        f"- **WER:** {wer_score:.2f}" if wer_score is not None else "- **WER:** N/A",
        f"- **CER:** {cer_score:.2f}" if cer_score is not None else "- **CER:** N/A",
    ]
    
    # Add AraDiaWER section for Arabic
    if aradiawer_details:
        aradiawer = aradiawer_details.get("aradiawer", 0)
        sem_score = aradiawer_details.get("semantic_score", 0)
        syn_score = aradiawer_details.get("syntactic_score", 0)
        
        lines.append(f"- **AraDiaWER:** {aradiawer:.2f}")
        lines.append(f"  - Semantic Score: {sem_score:.3f}")
        lines.append(f"  - Syntactic Score: {syn_score:.3f}")
        
        if wer_score and wer_score > 0:
            reduction = ((wer_score - aradiawer) / wer_score) * 100
            lines.append(f"  - WER Reduction: {reduction:.1f}%")
    
    lines += [
        "",
        "## Performance",
        f"- **Total load time:** {results.total_load_time_ms:.2f} ms",
        f"- **Total run time:** {results.total_run_time_ms:.2f} ms",
        "",
        "## Notes",
        f"- {notes}",
    ]
    
    # Add AraDiaWER reference for Arabic benchmarks
    if aradiawer_details:
        lines += [
            "",
            "## AraDiaWER Reference",
            "",
            "AraDiaWER is an explainable metric for Dialectical Arabic ASR evaluation.",
            "It refines WER by incorporating syntactic and semantic analysis:",
            "",
            "**Formula:** `AraDiaWER = WER / (Score_sem + Score_syn)`",
            "",
            "- **Semantic Score:** Measures meaning similarity between transcripts",
            "- **Syntactic Score:** Measures morphological/grammatical alignment",
            "",
            "Reference: [AraDiaWER Paper](https://aclanthology.org/2023.fieldmatters-1.8.pdf)",
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
                r"\*\*VAD:\*\*\s*(.+)", text
            )
            vad_info = vad_m.group(1).strip() if vad_m else ""
            
            vad_status = "✓" if "enabled" in vad_info.lower() else "-"

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
        "For @qvac/transcription-whispercpp, VAD is built-in and can be enabled/disabled via the `vad` flag in whisperConfig.",
        "",
        "| VAD | Description |",
        "|-----|-------------|",
        "| ✓   | Built-in VAD is enabled |",
        "| -   | Built-in VAD is disabled |",
        "",
    ]

    summary_path.write_text("\n".join(out), encoding="utf-8")
