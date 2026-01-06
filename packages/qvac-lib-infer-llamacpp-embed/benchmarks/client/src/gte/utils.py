import re
import json
from datetime import datetime
from pathlib import Path
from src.gte.config import Config


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
    notes: str = None,
):
    """
    Save individual benchmark results to markdown files under benchmarks/results/<quantization>/
    Automatically scans for dataset JSON files based on cfg.dataset array.

    Args:
        cfg: Configuration object containing dataset array
        notes: Optional notes about the benchmark run
    """
    results_root = _get_results_root()

    # Find the benchmark results directory
    project_root = Path(__file__).resolve().parents[3]
    benchmark_results_dir = (
        project_root
        / "client"
        / "benchmark_results"
        / "no_model_name_available"
        / "no_revision_available"
    )

    if not benchmark_results_dir.exists():
        raise FileNotFoundError(
            f"Benchmark results directory not found: {benchmark_results_dir}"
        )

    addon = cfg.server.lib
    quant = addon.rsplit("-", 1)[-1]
    notes = notes or f"Performed on GPU"

    # Process each dataset in the config
    for dataset_name in cfg.dataset:
        json_file = benchmark_results_dir / f"{dataset_name}.json"

        if not json_file.exists():
            print(f"Warning: Dataset file not found: {json_file}")
            continue

        # Load the JSON results
        with open(json_file, "r", encoding="utf-8") as f:
            results = json.load(f)

        config_name = f"{dataset_name}-gte-large-{quant}"

        # Create quantization folder
        quant_dir = results_root / quant
        quant_dir.mkdir(parents=True, exist_ok=True)

        md_path = quant_dir / f"{config_name}.md"

        addon_info = f'"{addon}": "{cfg.server.version}"'

        # Extract scores from results
        test_scores = results["scores"]["test"][0]

        lines = [
            f"# Benchmark Results for {config_name}",
            "",
            f"**Addon:** {addon_info}",
            "",
            "## Dataset",
            f"- **Name:** {results['task_name']}",
            f"- **Languages:** {', '.join(test_scores['languages'])}",
            f"- **Revision:** {results['dataset_revision']}",
            "- **Split:** test",
            "",
            "## Scores",
            f"- **nDCG@k (k=10):** {test_scores['ndcg_at_10']:.5f}",
            f"- **MRR@k (k=10):** {test_scores['mrr_at_10']:.6f}",
            f"- **Recall@k (k=10):** {test_scores['recall_at_10']:.5f}",
            f"- **Precision@k (k=10):** {test_scores['precision_at_10']:.5f}",
            "",
            "## Performance",
            f"- **Total run time:** {results['evaluation_time']:.12f} ms",
            "",
            "## Notes",
            f"- {notes}",
        ]

        md_path.write_text("\n".join(lines), encoding="utf-8")
        print(f"Generated results for {dataset_name}: {md_path}")


def generate_summary():
    """
    Scan benchmarks/results/<quantization>/dataset-model-quantization.md
    and rewrite benchmarks/results/results_summary.md as one aggregated table
    """
    results_root = _get_results_root()
    summary_path = results_root / "results_summary.md"

    quant_dirs = sorted(
        d for d in results_root.iterdir() if d.is_dir() and not d.name.startswith(".")
    )

    out = [
        "# Aggregated Benchmark Results",
        "",
        "This summary consolidates benchmarking results across all datasets.",
        "",
        "Original Model: [GTE-Large](https://huggingface.co/thenlper/gte-large)",
        "",
        "| Dataset   | Languages | Model     | Quantization | Version | nDCG@k (k=10) | MRR@k (k=10) | Recall@k (k=10) | Precision@k (k=10) | Notes            |",
        "| --------- | --------- | --------- | ------------ | ------- | ------------- | ------------ | --------------- | ------------------ | ---------------- |",
    ]

    for quant_dir in quant_dirs:
        quant = quant_dir.name
        for md_file in sorted(quant_dir.glob("*.md")):
            text = md_file.read_text(encoding="utf-8")
            stem = md_file.stem

            parts = stem.split("-")
            if len(parts) != 4:
                continue
            dataset, model_prefix, model_suffix, file_quant = parts
            model = f"{model_prefix}-{model_suffix}"

            if file_quant != quant:
                raise ValueError(
                    f"Quantization mismatch: {file_quant} != {quant} in {md_file}"
                )

            # Extract addon info
            addon_m = re.search(
                r"\*\*Addon:\*\*\s*\"([^\"]+)\"\s*:\s*\"([^\"]+)\"", text
            )
            addon_id = addon_m.group(1) if addon_m else ""
            version = addon_m.group(2) if addon_m else ""

            # Extract dataset info
            dataset_name_m = re.search(r"- \*\*Name:\*\*\s*([^\n]+)", text)
            dataset_name = (
                dataset_name_m.group(1).strip() if dataset_name_m else dataset
            )

            # Extract languages
            languages_m = re.search(r"- \*\*Languages:\*\*\s*([^\n]+)", text)
            languages = languages_m.group(1).strip() if languages_m else ""

            # Extract scores
            ndcg_m = re.search(r"- \*\*nDCG@k \(k=10\):\*\*\s*([\d\.]+)", text)
            mrr_m = re.search(r"- \*\*MRR@k \(k=10\):\*\*\s*([\d\.]+)", text)
            recall_m = re.search(r"- \*\*Recall@k \(k=10\):\*\*\s*([\d\.]+)", text)
            precision_m = re.search(
                r"- \*\*Precision@k \(k=10\):\*\*\s*([\d\.]+)", text
            )

            ndcg = ndcg_m.group(1) if ndcg_m else ""
            mrr = mrr_m.group(1) if mrr_m else ""
            recall = recall_m.group(1) if recall_m else ""
            precision = precision_m.group(1) if precision_m else ""

            # Extract notes
            notes_m = re.search(r"## Notes\s*\n- (.+)", text)
            notes = notes_m.group(1).strip() if notes_m else ""

            # Append the row
            out.append(
                f"| {dataset_name}  | {languages}  | {model}     | {quant}      | {version}   | {ndcg}       | {mrr}     | {recall}          | {precision}            | {notes}            |"
            )

    out += [
        "",
        "## Reference",
        "",
        "### nDCG@k (Normalized Discounted Cumulative Gain)",
        "",
        "Evaluates how well the ranked list of retrieved passages reflects ideal (ground-truth) relevance, discounted by position.",
        "",
        "Range: 0 – 1, **Higher = better**",
        "",
        "| **Score Range** | **Interpretation**                                 |",
        "| --------------- | -------------------------------------------------- |",
        "| 0.9 – 1.0       | Excellent; rankings are almost perfectly ideal     |",
        "| 0.7 – 0.9       | Strong; minor ranking imperfections                |",
        "| 0.5 – 0.7       | Adequate; some relevant items are pushed down      |",
        "| < 0.5           | Weak; many relevant items appear low in the list   |",
        "",
        "---",
        "",
        "### MRR@k (Mean Reciprocal Rank)",
        "",
        "Measures the position of the **first relevant** item in each query's ranked list; averages the reciprocal of that rank across all queries.",
        "",
        "Range: 0 – 1, **Higher = better**",
        "",
        "| **Score Range** | **Interpretation**                               |",
        "| --------------- | ------------------------------------------------ |",
        "| 0.9 – 1.0       | Excellent; relevant result is almost always top  |",
        "| 0.7 – 0.9       | Strong; relevant result usually in top few ranks |",
        "| 0.4 – 0.7       | Moderate; users may need to scroll                |",
        "| < 0.4           | Poor; relevant result often buried                |",
        "",
        "---",
        "",
        "### Recall@k",
        "",
        "Proportion of all relevant items that appear within the top _k_ results.",
        "",
        "Range: 0 – 1, **Higher = better**",
        "",
        "| **Score Range** | **Interpretation**                                |",
        "| --------------- | ------------------------------------------------- |",
        "| 0.9 – 1.0       | Excellent coverage; nearly all relevant items found |",
        "| 0.7 – 0.9       | Strong coverage                                    |",
        "| 0.5 – 0.7       | Adequate; may miss some relevant items             |",
        "| < 0.5           | Limited; many relevant items missed                |",
        "",
        "---",
        "",
        "### Precision@k",
        "",
        "Fraction of the top _k_ retrieved items that are relevant.",
        "",
        "Range: 0 – 1, **Higher = better**",
        "",
        "| **Score Range** | **Interpretation**                              |",
        "| --------------- | ----------------------------------------------- |",
        "| 0.9 – 1.0       | Excellent precision; very few false positives   |",
        "| 0.7 – 0.9       | Strong precision                                |",
        "| 0.5 – 0.7       | Acceptable; noticeable non-relevant items       |",
        "| < 0.5           | Low precision; many non-relevant items returned |",
        "",
        "---",
        "",
    ]

    summary_path.write_text("\n".join(out), encoding="utf-8")
