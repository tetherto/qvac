"""
VAD Evaluation Report Generator - Markdown Only
===============================================

This module generates comprehensive markdown reports for VAD model evaluation results.
It creates detailed summaries including metrics, visualizations, and analysis.
"""

import numpy as np
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional


def format_number(value: float, decimal_places: int = 4) -> str:
    """Format a number with proper decimal places and handle NaN values."""
    if np.isnan(value):
        return "N/A"
    return f"{value:.{decimal_places}f}"


def format_percentage(value: float, decimal_places: int = 1) -> str:
    """Format a value as percentage."""
    if np.isnan(value):
        return "N/A"
    return f"{value * 100:.{decimal_places}f}%"


def create_per_file_table(per_file_metrics: List[Dict]) -> str:
    """Create a detailed table of per-file metrics."""
    if not per_file_metrics:
        return "No per-file metrics available.\n"

    table = """
## Per-File Results

| File | Accuracy | ROC-AUC | Speech Precision | Speech Recall | Speech F1 | Length | Speech Ratio (Pred) | Speech Ratio (Ref) | Error |
|------|----------|---------|------------------|---------------|-----------|--------|---------------------|-------------------|-------|
"""

    for file_metrics in per_file_metrics:
        file_idx = file_metrics.get('file_index', 'N/A')
        valid = file_metrics.get('valid', False)

        if valid:
            accuracy = format_percentage(file_metrics.get('accuracy', 0))
            roc_auc = format_number(file_metrics.get('roc_auc', np.nan))
            speech_precision = format_percentage(file_metrics.get('speech_precision', 0))
            speech_recall = format_percentage(file_metrics.get('speech_recall', 0))
            speech_f1 = format_percentage(file_metrics.get('speech_f1', 0))
            length = f"{file_metrics.get('length', 0):,}"
            speech_ratio_pred = format_percentage(file_metrics.get('speech_ratio_pred', 0))
            speech_ratio_ref = format_percentage(file_metrics.get('speech_ratio_ref', 0))
            error = ""
        else:
            accuracy = roc_auc = speech_precision = speech_recall = speech_f1 = "N/A"
            length = speech_ratio_pred = speech_ratio_ref = "N/A"
            error = file_metrics.get('error', 'Unknown error')

        table += f"| {file_idx} | {accuracy} | {roc_auc} | {speech_precision} | {speech_recall} | {speech_f1} | {length} | {speech_ratio_pred} | {speech_ratio_ref} | {error} |\n"

    return table


def generate_results_summary(metrics: Dict,
                             model_info: Optional[Dict] = None,
                             config_info: Optional[Dict] = None,
                             output_path: str = "results/results_summary.md",
                             verbose=False) -> str:
    """
    Generate a comprehensive markdown report of VAD evaluation results.

    Args:
        metrics (Dict): Metrics dictionary from calculate_vad_metrics
        model_info (Dict): Optional model information (version, timing, etc.)
        config_info (Dict): Optional configuration information
        output_path (str): Path to save the markdown report
        verbose (bool): generate verbose result

    Returns:
        str: Path to the generated report file
    """

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Start building the report
    report = f"""# VAD Model Evaluation Report

**Generated on**: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

"""

    # Add model information if available
    if model_info:
        report += "## Model Information\n\n"
        if 'model_version' in model_info:
            report += f"- **Model Version**: {model_info['model_version']}\n"
        if 'model_name' in model_info:
            report += f"- **Model Name**: {model_info['model_name']}\n"
        if 'dataset' in model_info:
            report += f"- **Test Dataset**: {model_info['dataset']}\n"
        if 'total_load_time_ms' in model_info:
            report += f"- **Model Load Time**: {model_info['total_load_time_ms']:.2f} ms\n"
        if 'total_run_time_ms' in model_info:
            report += f"- **Total Processing Time**: {model_info['total_run_time_ms']:.2f} ms\n"
        report += "\n"

    # Handle error case
    if 'error' in metrics:
        report += f"## Error\n\n**{metrics['error']}**\n\n"
        # Save the report and return early
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(report)
        return str(output_path)

    # Results Summary Section
    report += "## Results Summary\n\n"

    # Overall Performance Metrics
    report += "### Overall Performance\n\n"
    report += f"- **Files Processed**: {metrics.get('files_processed', 0)}/{metrics.get('files_total', 0)}\n"
    report += f"- **Total Audio Samples**: {metrics.get('total_samples', 0):,}\n"
    report += f"- **Overall Accuracy**: {format_percentage(metrics.get('overall_accuracy', 0))}\n"

    roc_auc = metrics.get('overall_roc_auc', np.nan)
    if not np.isnan(roc_auc):
        report += f"- **ROC-AUC**: {format_number(roc_auc)}\n"
    else:
        report += f"- **ROC-AUC**: N/A (insufficient class diversity)\n"

    report += "\n"

    # Speech Detection Performance
    report += "### Speech Detection Performance\n\n"
    report += f"- **Speech Precision**: {format_percentage(metrics.get('speech_precision', 0))}\n"
    report += f"- **Speech Recall**: {format_percentage(metrics.get('speech_recall', 0))}\n"
    report += f"- **Speech F1-Score**: {format_percentage(metrics.get('speech_f1', 0))}\n"
    report += "\n"

    # Silence Detection Performance
    report += "### Silence Detection Performance\n\n"
    report += f"- **Silence Precision**: {format_percentage(metrics.get('silence_precision', 0))}\n"
    report += f"- **Silence Recall**: {format_percentage(metrics.get('silence_recall', 0))}\n"
    report += f"- **Silence F1-Score**: {format_percentage(metrics.get('silence_f1', 0))}\n"
    report += "\n"

    if not verbose:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(report)

        print(f"Report saved to: {output_path}")
        return str(output_path)

    # Data Distribution
    report += "### Data Distribution\n\n"
    report += f"- **Speech Ratio (Predicted)**: {format_percentage(metrics.get('speech_ratio_pred', 0))}\n"
    report += f"- **Speech Ratio (Reference)**: {format_percentage(metrics.get('speech_ratio_ref', 0))}\n"

    speech_ratio_pred = metrics.get('speech_ratio_pred', 0)
    speech_ratio_ref = metrics.get('speech_ratio_ref', 0)
    ratio_diff = abs(speech_ratio_pred - speech_ratio_ref)
    report += f"- **Distribution Bias**: {format_percentage(ratio_diff)} (absolute difference)\n"
    report += "\n"

    # Confusion Matrix
    conf_matrix = metrics.get('confusion_matrix')
    if conf_matrix is not None and conf_matrix.size > 0:
        report += "### Confusion Matrix\n\n"
        report += "|              | Predicted Silence | Predicted Speech |\n"
        report += "|--------------|-------------------|------------------|\n"
        if conf_matrix.shape == (2, 2):
            report += f"| **Actual Silence** | {conf_matrix[0][0]:,} | {conf_matrix[0][1]:,} |\n"
            report += f"| **Actual Speech**  | {conf_matrix[1][0]:,} | {conf_matrix[1][1]:,} |\n"
        report += "\n"

    # Per-file Statistics Summary
    file_stats = metrics.get('per_file_stats', {})
    if file_stats:
        report += "### Per-File Statistics Summary\n\n"

        if 'accuracy' in file_stats:
            acc_stats = file_stats['accuracy']
            report += f"- **Accuracy**: Mean={format_percentage(acc_stats['mean'])}, Std={format_number(acc_stats['std'])}, Range=[{format_percentage(acc_stats['min'])} - {format_percentage(acc_stats['max'])}]\n"

        if 'roc_auc' in file_stats:
            roc_stats = file_stats['roc_auc']
            report += f"- **ROC-AUC**: Mean={format_number(roc_stats['mean'])}, Std={format_number(roc_stats['std'])}, Range=[{format_number(roc_stats['min'])} - {format_number(roc_stats['max'])}]\n"

        if 'speech_f1' in file_stats:
            f1_stats = file_stats['speech_f1']
            report += f"- **Speech F1-Score**: Mean={format_percentage(f1_stats['mean'])}, Std={format_number(f1_stats['std'])}, Range=[{format_percentage(f1_stats['min'])} - {format_percentage(f1_stats['max'])}]\n"

        report += "\n"

    # Add per-file detailed table
    per_file_metrics = metrics.get('per_file_metrics', [])
    if per_file_metrics:
        report += create_per_file_table(per_file_metrics)

    # Save the report
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(report)

    print(f"Report saved to: {output_path}")
    return str(output_path)
