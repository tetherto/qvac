import re
from pathlib import Path
from src.parakeet.config import Config
from src.parakeet.client import AddonResults


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
):
    """
    Save individual benchmark results to a markdown file under benchmarks/results/<model_name>/
    
    Args:
        cfg: Configuration object
        wer_score: Word Error Rate score
        cer_score: Character Error Rate score
        results: Transcription results from the addon
        notes: Optional notes to include
    """
    results_root = _get_results_root()

    addon = cfg.server.lib
    dataset_type = cfg.dataset.dataset_type.value
    speaker_group = cfg.dataset.speaker_group.value
    language = cfg.dataset.language.value
    
    model_path = cfg.model.path
    model_name = Path(model_path).name
    model_type = cfg.model.model_type.value
    
    streaming_status = "streaming" if cfg.model.streaming else "batch"
    gpu_status = "gpu" if cfg.model.use_gpu else "cpu"
    config_name = f"{dataset_type}-{language}-{speaker_group}-{model_type}-{gpu_status}-{streaming_status}"

    model_dir = results_root / model_name
    model_dir.mkdir(parents=True, exist_ok=True)

    md_path = model_dir / f"{config_name}.md"

    addon_info = f'"{addon}": "{cfg.server.version}"'
    gpu_info = "Enabled" if cfg.model.use_gpu else "Disabled"
    streaming_info = "Enabled" if cfg.model.streaming else "Disabled"
    notes = notes or f"Model type: {model_type}, Threads: {cfg.model.max_threads}"
    num_samples = len(results.transcriptions)

    lines = [
        f"# Benchmark Results for {config_name}",
        "",
        f"**Addon:** {addon_info}",
        "",
        f"**Model Type:** {model_type}",
        "",
        f"**GPU Acceleration:** {gpu_info}",
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
    Scan all result files in benchmarks/results/<model_name>/ and rewrite results_summary.md
    """
    results_root = _get_results_root()
    summary_path = results_root / "results_summary.md"

    model_dirs = [
        d for d in results_root.iterdir() if d.is_dir() and not d.name.startswith(".")
    ]

    out = [
        "# Aggregated Benchmark Results",
        "",
        "This summary consolidates benchmarking results across all model configurations.",
        "",
        "| Model | Type | Language | Speaker Group | GPU | Mode | WER | CER | Dataset | Notes |",
        "|-------|------|----------|---------------|-----|------|-----|-----|---------|-------|",
    ]

    for model_dir in sorted(model_dirs):
        model_name = model_dir.name
        for md_file in sorted(model_dir.glob("*.md")):
            text = md_file.read_text(encoding="utf-8")
            stem = md_file.stem

            # Parse model type
            type_m = re.search(r"\*\*Model Type:\*\*\s*([^\n]+)", text)
            model_type = type_m.group(1).strip() if type_m else ""

            # GPU status
            gpu_m = re.search(r"\*\*GPU Acceleration:\*\*\s*(.+)", text)
            gpu_info = gpu_m.group(1).strip() if gpu_m else ""
            gpu_status = "✓" if "enabled" in gpu_info.lower() else "-"

            # Streaming status
            stream_m = re.search(r"\*\*Streaming Mode:\*\*\s*(.+)", text)
            stream_info = stream_m.group(1).strip() if stream_m else ""
            stream_status = "streaming" if "enabled" in stream_info.lower() else "batch"

            # Language
            lang_m = re.search(r"\*\*Language:\*\*\s*([^\n]+)", text)
            language = lang_m.group(1).strip() if lang_m else ""

            # Speaker group
            sg_m = re.search(r"\*\*Speaker group:\*\*\s*([^\n]+)", text)
            speaker_group = sg_m.group(1).strip() if sg_m else ""

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
                f"| {model_name} | {model_type} | {language} | {speaker_group} | {gpu_status} | {stream_status} | {wer} | {cer} | {dataset} | {notes} |"
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
        "### Model Types",
        "",
        "| Model Type | Description |",
        "|------------|-------------|",
        "| tdt        | Token-and-Duration Transducer (default) |",
        "| ctc        | Connectionist Temporal Classification |",
        "| eou        | End-of-Utterance detection |",
        "| sortformer | Sortformer architecture |",
        "",
    ]

    summary_path.write_text("\n".join(out), encoding="utf-8")
