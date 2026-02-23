"""Utility functions for TTS benchmarks"""

import logging
from pathlib import Path
from typing import Dict, List, Optional
import statistics
import numpy as np

from .config import Config
from .client import TTSResults

logger = logging.getLogger(__name__)


def _get_results_root() -> Path:
    """Get the results directory"""
    project_root = Path(__file__).resolve().parents[3]
    results_root = project_root / "results"
    results_root.mkdir(parents=True, exist_ok=True)
    return results_root


def _get_model_name(cfg: Config) -> str:
    """Get model name from config"""
    model_path = getattr(cfg.model, 'modelDir', None)
    return Path(model_path).stem if model_path else "chatterbox"


def calculate_percentiles(values: List[float]) -> Dict[str, float]:
    """Calculate percentile statistics"""
    if not values:
        return {"p50": 0, "p90": 0, "p95": 0, "p99": 0}
    
    sorted_vals = sorted(values)
    return {
        "p50": statistics.median(sorted_vals),
        "p90": statistics.quantiles(sorted_vals, n=10)[8] if len(sorted_vals) >= 10 else sorted_vals[-1],
        "p95": statistics.quantiles(sorted_vals, n=20)[18] if len(sorted_vals) >= 20 else sorted_vals[-1],
        "p99": statistics.quantiles(sorted_vals, n=100)[98] if len(sorted_vals) >= 100 else sorted_vals[-1]
    }


def save_single_result(cfg: Config, results: TTSResults, label: str, round_trip_metrics: Optional[Dict] = None):
    """Save results for a single implementation
    
    Args:
        cfg: Configuration object
        results: TTS benchmark results
        label: Label for the implementation (e.g., "addon", "python-native")
        round_trip_metrics: Optional round-trip quality metrics (WER/CER)
    """
    results_root = _get_results_root()
    
    model_name = _get_model_name(cfg)
    md_path = results_root / f"{model_name}_{label}.md"
    
    rtf_values = [r.rtf for r in results.results]
    percentiles = calculate_percentiles(rtf_values)
    
    lines = [
        f"# TTS Benchmark Results: {label}",
        "",
        f"**Implementation:** {results.implementation}",
        f"**Version:** {results.version}",
        f"**Model:** {model_name}",
        f"**Dataset:** {cfg.dataset.name}",
        f"**Samples:** {len(results.results)}",
        "",
    ]
    
    # Add round-trip quality metrics if available
    if round_trip_metrics and round_trip_metrics.get('runs'):
        rt = round_trip_metrics['runs'][0]  # Use first run metrics
        lines.extend([
            "## Quality Metrics (Round-Trip Test)",
            "",
            f"- **Average WER:** {rt['avg_wer']:.2%}",
            f"- **Average CER:** {rt['avg_cer']:.2%}",
            f"- **Min WER:** {rt['min_wer']:.2%}",
            f"- **Max WER:** {rt['max_wer']:.2%}",
            f"- **Min CER:** {rt['min_cer']:.2%}",
            f"- **Max CER:** {rt['max_cer']:.2%}",
            f"- **Samples Tested:** {round_trip_metrics.get('total_tested', len(results.results))}",
            "",
        ])
    
    lines.extend([
        "## Performance Metrics",
        "",
        f"- **Model Load Time:** {results.load_time_ms:.2f} ms",
        f"- **Total Generation Time:** {results.total_generation_ms:.2f} ms",
        f"- **Total Audio Duration:** {results.total_audio_duration:.2f} s",
        f"- **Average RTF:** {results.avg_rtf:.4f}",
        "",
        "## RTF Distribution",
        "",
        f"- **p50 (median):** {percentiles['p50']:.4f}",
        f"- **p90:** {percentiles['p90']:.4f}",
        f"- **p95:** {percentiles['p95']:.4f}",
        f"- **p99:** {percentiles['p99']:.4f}",
        "",
        "## Interpretation",
        "",
        "**RTF (Real-Time Factor)** = generation_time / audio_duration",
        "",
        "- RTF < 1.0 means faster than real-time (good!)",
        "- RTF > 1.0 means slower than real-time (bad)",
        "- Lower RTF is better (more efficient)",
        f"- This implementation runs at **{(1 / results.avg_rtf) if results.avg_rtf > 0 else 0:.2f}x real-time speed**",
        ""
    ])
    
    md_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info(f"Saved results to {md_path}")


def round_trip_single_implementation(
    original_texts: List[str],
    runs: List[TTSResults],
    whisper_transcriber,
    implementation_name: str
) -> Optional[Dict]:
    """
    Perform round-trip quality test for a single implementation
    
    Args:
        original_texts: Original input texts
        runs: List of results from implementation (one per run)
        whisper_transcriber: Loaded WhisperTranscriber instance
        implementation_name: Name of implementation for logging
        
    Returns:
        Dict with WER/CER metrics for each run or None if samples not available
    """
    from jiwer import wer, cer
    
    if not runs or not runs[0].results:
        return None
    
    # Check if samples are available
    if not runs[0].results[0].samples:
        logger.info(f"Audio samples not available for {implementation_name} round-trip test")
        return None
    
    logger.info(f"Running round-trip quality test for {implementation_name} with {len(runs)} run(s)...")
    
    # Process each run
    run_metrics = []
    
    for run_idx, results in enumerate(runs, 1):
        logger.info(f"Processing {implementation_name} run {run_idx}/{len(runs)}...")
        
        wers = []
        cers = []
        
        for i, (original, result) in enumerate(zip(original_texts, results.results)):
            if result.samples:
                # Transcribe audio
                samples = np.array(result.samples, dtype=np.int16)
                transcription = whisper_transcriber.transcribe_samples(samples, result.sample_rate)
                
                # Normalize texts for comparison (lowercase, strip)
                original_norm = original.lower().strip()
                trans_norm = transcription.lower().strip()
                
                # Calculate WER and CER
                try:
                    wer_val = wer(original_norm, trans_norm)
                    cer_val = cer(original_norm, trans_norm)
                    
                    wers.append(wer_val)
                    cers.append(cer_val)
                    
                    logger.debug(f"{implementation_name} Run {run_idx}, Sample {i+1}: WER={wer_val:.3f}, CER={cer_val:.3f}")
                except Exception as e:
                    logger.warning(f"Failed to calculate error rates for {implementation_name} run {run_idx}, sample {i+1}: {e}")
        
        if wers:
            run_metrics.append({
                "avg_wer": np.mean(wers),
                "std_wer": np.std(wers),
                "min_wer": np.min(wers),
                "max_wer": np.max(wers),
                "avg_cer": np.mean(cers),
                "std_cer": np.std(cers),
                "min_cer": np.min(cers),
                "max_cer": np.max(cers),
            })
    
    if not run_metrics:
        return None
    
    return {
        "runs": run_metrics,
        "total_tested": len(runs[0].results)
    }


def round_trip_quality_test(
    original_texts: List[str],
    addon_runs: List[TTSResults],
    python_runs: List[TTSResults],
    whisper_transcriber
) -> Optional[Dict]:
    """
    Perform round-trip quality test: TTS -> Audio -> Whisper -> Text
    Compare transcribed text to original using WER and CER
    
    Args:
        original_texts: Original input texts
        addon_runs: List of results from addon implementation (one per run)
        python_runs: List of results from python native implementation (one per run)
        whisper_transcriber: Loaded WhisperTranscriber instance
        
    Returns:
        Dict with WER/CER metrics for each run or None if samples not available
    """
    addon_metrics = round_trip_single_implementation(original_texts, addon_runs, whisper_transcriber, "Addon")
    python_metrics = round_trip_single_implementation(original_texts, python_runs, whisper_transcriber, "Python")
    
    if not addon_metrics or not python_metrics:
        return None
    
    return {
        "addon": addon_metrics,
        "python": python_metrics,
        "total_tested": min(addon_metrics.get("total_tested", 0), python_metrics.get("total_tested", 0))
    }


def save_comparison_report(cfg: Config, addon_runs: List[TTSResults], python_runs: List[TTSResults], round_trip_results: Optional[Dict] = None):
    """Save comparison report between addon and python implementations"""
    results_root = _get_results_root()
    
    model_name = _get_model_name(cfg)
    md_path = results_root / f"{model_name}_comparison.md"
    
    # Use first run for base comparison
    addon_results = addon_runs[0]
    python_results = python_runs[0]
    
    # Calculate metrics
    load_time_diff_pct = ((addon_results.load_time_ms - python_results.load_time_ms) / python_results.load_time_ms) * 100
    rtf_diff_pct = ((addon_results.avg_rtf - python_results.avg_rtf) / python_results.avg_rtf) * 100
    gen_time_diff_pct = ((addon_results.total_generation_ms - python_results.total_generation_ms) / python_results.total_generation_ms) * 100
    speedup = python_results.total_generation_ms / addon_results.total_generation_ms if addon_results.total_generation_ms > 0 else 0
    
    addon_rtfs = [r.rtf for r in addon_results.results]
    python_rtfs = [r.rtf for r in python_results.results]
    addon_percentiles = calculate_percentiles(addon_rtfs)
    python_percentiles = calculate_percentiles(python_rtfs)
    
    lines = [
        f"# TTS Benchmark Comparison: Addon vs Python Native",
        "",
        f"**Model:** {model_name}",
        f"**Dataset:** {cfg.dataset.name}",
        f"**Samples:** {len(addon_results.results)}",
        "",
    ]
    
    # Add round-trip quality test section if available
    if round_trip_results:
        addon_runs_rt = round_trip_results['addon']['runs']
        python_runs_rt = round_trip_results['python']['runs']
        num_runs = len(addon_runs_rt)
        
        lines.extend([
            "## Round-Trip Quality Test (TTS → Whisper → Text)",
            "",
            f"Tested {round_trip_results['total_tested']} samples using Whisper transcription across {num_runs} run(s):",
            "",
        ])
        
        if num_runs > 1:
            # Add variance table for multiple runs
            lines.extend([
                "### Determinism Analysis (Multiple Runs)",
                "",
                "**TTS Addon WER by Run:**",
                "",
            ])
            
            # Create WER table header
            wer_header = "| Metric |"
            wer_sep = "|--------|"
            for i in range(num_runs):
                wer_header += f" Run {i+1} |"
                wer_sep += "--------|"
            lines.append(wer_header)
            lines.append(wer_sep)
            
            # Average WER
            avg_row = "| Avg WER |"
            for run_data in addon_runs_rt:
                avg_row += f" {run_data['avg_wer']:.2%} |"
            lines.append(avg_row)
            
            # Std Dev WER
            std_row = "| Std Dev |"
            for run_data in addon_runs_rt:
                std_row += f" {run_data['std_wer']:.2%} |"
            lines.append(std_row)
            
            lines.extend([
                "",
                "**TTS Addon CER by Run:**",
                "",
            ])
            
            # Create CER table header
            cer_header = "| Metric |"
            cer_sep = "|--------|"
            for i in range(num_runs):
                cer_header += f" Run {i+1} |"
                cer_sep += "--------|"
            lines.append(cer_header)
            lines.append(cer_sep)
            
            # Average CER
            avg_cer_row = "| Avg CER |"
            for run_data in addon_runs_rt:
                avg_cer_row += f" {run_data['avg_cer']:.2%} |"
            lines.append(avg_cer_row)
            
            # Std Dev CER
            std_cer_row = "| Std Dev |"
            for run_data in addon_runs_rt:
                std_cer_row += f" {run_data['std_cer']:.2%} |"
            lines.append(std_cer_row)
            
            lines.extend([
                "",
                "**Python Native WER by Run:**",
                "",
            ])
            
            # Create WER table header for Python
            wer_header = "| Metric |"
            wer_sep = "|--------|"
            for i in range(num_runs):
                wer_header += f" Run {i+1} |"
                wer_sep += "--------|"
            lines.append(wer_header)
            lines.append(wer_sep)
            
            # Average WER
            avg_row = "| Avg WER |"
            for run_data in python_runs_rt:
                avg_row += f" {run_data['avg_wer']:.2%} |"
            lines.append(avg_row)
            
            # Std Dev WER
            std_row = "| Std Dev |"
            for run_data in python_runs_rt:
                std_row += f" {run_data['std_wer']:.2%} |"
            lines.append(std_row)
            
            lines.extend([
                "",
                "**Python Native CER by Run:**",
                "",
            ])
            
            # Create CER table header for Python
            cer_header = "| Metric |"
            cer_sep = "|--------|"
            for i in range(num_runs):
                cer_header += f" Run {i+1} |"
                cer_sep += "--------|"
            lines.append(cer_header)
            lines.append(cer_sep)
            
            # Average CER
            avg_cer_row = "| Avg CER |"
            for run_data in python_runs_rt:
                avg_cer_row += f" {run_data['avg_cer']:.2%} |"
            lines.append(avg_cer_row)
            
            # Std Dev CER
            std_cer_row = "| Std Dev |"
            for run_data in python_runs_rt:
                std_cer_row += f" {run_data['std_cer']:.2%} |"
            lines.append(std_cer_row)
            
            lines.append("")
            
            # Calculate variance across runs
            addon_wer_variance = np.var([run['avg_wer'] for run in addon_runs_rt])
            python_wer_variance = np.var([run['avg_wer'] for run in python_runs_rt])
            
            if addon_wer_variance < 0.0001 and python_wer_variance < 0.0001:
                lines.append("✅ **Excellent determinism** - WER is highly consistent across runs (variance < 0.01%)")
            elif addon_wer_variance < 0.001 and python_wer_variance < 0.001:
                lines.append("✅ **Good determinism** - WER shows minimal variance across runs (variance < 0.1%)")
            else:
                lines.append(f"⚠️ **Variance detected** - WER varies across runs (Addon variance: {addon_wer_variance:.4%}, Python variance: {python_wer_variance:.4%})")
            
            lines.append("")
        
        # Summary comparison using first run
        addon_rt = addon_runs_rt[0]
        python_rt = python_runs_rt[0]
        
        lines.extend([
            "### Overall Quality Comparison (Run 1)",
            "",
            "**Word Error Rate (WER):**",
            "",
            "| Implementation | Average | Min | Max |",
            "|----------------|---------|-----|-----|",
            f"| TTS Addon | {addon_rt['avg_wer']:.2%} | {addon_rt['min_wer']:.2%} | {addon_rt['max_wer']:.2%} |",
            f"| Python Native | {python_rt['avg_wer']:.2%} | {python_rt['min_wer']:.2%} | {python_rt['max_wer']:.2%} |",
            "",
            "**Character Error Rate (CER):**",
            "",
            "| Implementation | Average | Min | Max |",
            "|----------------|---------|-----|-----|",
            f"| TTS Addon | {addon_rt['avg_cer']:.2%} | {addon_rt['min_cer']:.2%} | {addon_rt['max_cer']:.2%} |",
            f"| Python Native | {python_rt['avg_cer']:.2%} | {python_rt['min_cer']:.2%} | {python_rt['max_cer']:.2%} |",
            "",
        ])
        
        # Add interpretation
        addon_wer = addon_rt['avg_wer']
        python_wer = python_rt['avg_wer']
        
        if addon_wer < 0.05 and python_wer < 0.05:
            lines.append("✅ **Excellent audio quality** - both implementations produce highly intelligible speech (WER < 5%)")
        elif addon_wer < 0.10 and python_wer < 0.10:
            lines.append("✅ **Good audio quality** - both implementations produce clear speech (WER < 10%)")
        elif addon_wer < 0.20 and python_wer < 0.20:
            lines.append("⚠️ **Acceptable audio quality** - some transcription errors detected (WER < 20%)")
        else:
            lines.append("❌ **Audio quality issues** - high transcription error rates (WER > 20%)")
        
        # Compare implementations
        wer_diff = abs(addon_wer - python_wer)
        if wer_diff < 0.02:
            lines.append("✅ **Implementations produce similar quality audio** (WER difference < 2%)")
        elif wer_diff < 0.05:
            lines.append("⚠️ **Minor quality differences detected** (WER difference < 5%)")
        else:
            better = "Addon" if addon_wer < python_wer else "Python"
            lines.append(f"⚠️ **{better} produces noticeably better audio quality** (WER difference {wer_diff:.2%})")
        
        lines.append("")
    
    # Performance comparison table
    load_indicator = '✅' if load_time_diff_pct < 0 else '⚠️'
    rtf_indicator = '✅' if rtf_diff_pct < 0 else '⚠️'  # Lower RTF is better
    gen_indicator = '✅' if gen_time_diff_pct < 0 else '⚠️'
    speed_word = 'faster' if speedup > 1 else 'slower'
    
    addon_realtime_speed = (1 / addon_results.avg_rtf) if addon_results.avg_rtf > 0 else 0
    python_realtime_speed = (1 / python_results.avg_rtf) if python_results.avg_rtf > 0 else 0
    
    lines.extend([
        "## Performance Comparison",
        "",
        "| Metric | TTS Addon | Python Native | Difference |",
        "|--------|-----------|---------------|------------|",
        f"| Model Load Time | {addon_results.load_time_ms:.2f} ms | {python_results.load_time_ms:.2f} ms | {load_time_diff_pct:+.1f}% {load_indicator} |",
        f"| Avg RTF | {addon_results.avg_rtf:.4f} | {python_results.avg_rtf:.4f} | {rtf_diff_pct:+.1f}% {rtf_indicator} |",
        f"| Total Generation | {addon_results.total_generation_ms:.2f} ms | {python_results.total_generation_ms:.2f} ms | {gen_time_diff_pct:+.1f}% {gen_indicator} |",
        f"| Real-time Speed | {addon_realtime_speed:.2f}x | {python_realtime_speed:.2f}x | Addon is {speedup:.2f}x {speed_word} |",
        "",
        "## RTF Distribution",
        "",
        "| Percentile | Addon | Python | Difference |",
        "|------------|-------|--------|------------|",
        f"| p50 (median) | {addon_percentiles['p50']:.4f} | {python_percentiles['p50']:.4f} | {((addon_percentiles['p50'] - python_percentiles['p50']) / python_percentiles['p50'] * 100):+.1f}% |",
        f"| p90 | {addon_percentiles['p90']:.4f} | {python_percentiles['p90']:.4f} | {((addon_percentiles['p90'] - python_percentiles['p90']) / python_percentiles['p90'] * 100):+.1f}% |",
        f"| p95 | {addon_percentiles['p95']:.4f} | {python_percentiles['p95']:.4f} | {((addon_percentiles['p95'] - python_percentiles['p95']) / python_percentiles['p95'] * 100):+.1f}% |",
        f"| p99 | {addon_percentiles['p99']:.4f} | {python_percentiles['p99']:.4f} | {((addon_percentiles['p99'] - python_percentiles['p99']) / python_percentiles['p99'] * 100):+.1f}% |",
        "",
        "## Summary",
        "",
    ])
    
    # Add summary analysis
    if speedup > 1:
        lines.append(f"✅ **Addon is {speedup:.2f}x faster** than Python native implementation")
    elif speedup < 1:
        lines.append(f"⚠️ **Addon is {1/speedup:.2f}x slower** than Python native implementation")
    else:
        lines.append("➡️ **Addon and Python have similar performance**")
    
    lines.extend([
        "",
        "### Key Findings:",
        "",
        f"- Model loading: Addon is **{abs(load_time_diff_pct):.1f}% {'faster' if load_time_diff_pct < 0 else 'slower'}**",
        f"- Average RTF: Addon is **{abs(rtf_diff_pct):.1f}% {'better' if rtf_diff_pct < 0 else 'worse'}**",
        f"- Total generation: Addon is **{abs(gen_time_diff_pct):.1f}% {'faster' if gen_time_diff_pct < 0 else 'slower'}**",
        "",
        "## Interpretation",
        "",
        "**RTF (Real-Time Factor)** = generation_time / audio_duration",
        "",
        "- RTF < 1.0 means faster than real-time",
        "- RTF > 1.0 means slower than real-time",
        "- Lower RTF is better (more efficient)",
        "- Negative percentage difference in RTF means addon is better",
        ""
    ])
    
    md_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info(f"Saved comparison report to {md_path}")

