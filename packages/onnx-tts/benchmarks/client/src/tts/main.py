"""
TTS Benchmark Client Main Entry Point

Runs benchmarks against both addon and python native servers
and generates comparison reports.
"""

import argparse
import logging
import random
import sys
from pathlib import Path

import numpy as np

from .config import Config
from .client import TTSClient
from .dataset import load_dataset_texts
from .utils import save_single_result, save_comparison_report, round_trip_quality_test, round_trip_single_implementation
from .whisper_transcriber import WhisperTranscriber

# Mapping for TTS language codes to Whisper language codes (where they differ)
# Whisper uses "no" for Norwegian, but TTS uses "nb" for Norwegian Bokmål
TTS_TO_WHISPER_LANG = {
    "nb": "no",  # Norwegian Bokmål -> Norwegian
    "cm": "zh",  # Chinese -> Chinese (Mandarin)
    "cmn": "zh",  # Chinese -> Chinese (Mandarin)
}

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


def run_supertonic_benchmark_suite(cfg: Config, config_path: str) -> None:
    """English on HF supertonic, Spanish (or other) on multilingual (HF supertonic-2) — one result file per language."""
    if not cfg.model.modelDirV1 or not cfg.model.modelDirMultilingual:
        logger.error(
            "Supertonic benchmark requires model.modelDirV1 and model.modelDirMultilingual "
            "(see config-supertonic.yaml)."
        )
        sys.exit(1)

    specs = [
        {
            "dataset_lang": "en",
            "tts_lang": "en",
            "model_dir": cfg.model.modelDirV1,
            "supertonic_multilingual": False,
        },
        {
            "dataset_lang": "es",
            "tts_lang": "es",
            "model_dir": cfg.model.modelDirMultilingual,
            "supertonic_multilingual": True,
        },
    ]

    for spec in specs:
        lang = spec["tts_lang"]
        logger.info("\n" + "=" * 60)
        logger.info("  Supertonic benchmark run: language=%s", lang)
        logger.info("=" * 60)

        texts = load_dataset_texts(cfg.dataset, language=spec["dataset_lang"])
        if not texts:
            logger.error("No texts for dataset language %s", spec["dataset_lang"])
            sys.exit(1)

        logger.info("Loaded %s texts (%s)", len(texts), spec["dataset_lang"])
        model_for_run = cfg.model.model_copy(
            update={
                "modelDir": spec["model_dir"],
                "language": spec["tts_lang"],
                "supertonicMultilingual": spec["supertonic_multilingual"],
            }
        )
        cfg_eff = cfg.model_copy(update={"model": model_for_run})

        whisper = None
        if cfg.comparison.round_trip_test:
            whisper_lang = (spec["tts_lang"][:2] if spec["tts_lang"] else "en")
            wl = TTS_TO_WHISPER_LANG.get(whisper_lang, whisper_lang)
            logger.info("Loading Whisper for round-trip (lang=%s)", wl)
            try:
                whisper = WhisperTranscriber(
                    model_size=cfg.comparison.whisper_model, language=wl
                )
                whisper.load()
            except Exception as e:
                logger.error("Failed to load Whisper: %s", e, exc_info=True)
                whisper = None

        if cfg.comparison.run_addon:
            logger.info("Running addon benchmark (%s)", lang)
            addon_client = TTSClient(
                cfg.server.addon_url,
                cfg_eff.model,
                timeout=cfg.server.timeout,
                batch_size=cfg.server.batch_size,
                include_samples=cfg.comparison.round_trip_test,
                num_runs=cfg.comparison.num_runs,
            )
            try:
                addon_runs = addon_client.synthesize_all(texts)
                addon_round_trip = None
                if cfg.comparison.round_trip_test and whisper:
                    addon_round_trip = round_trip_single_implementation(
                        texts, addon_runs, whisper, "Addon"
                    )
                save_single_result(
                    cfg_eff,
                    addon_runs[0],
                    "addon",
                    addon_round_trip,
                    result_language=lang,
                )
            finally:
                addon_client.close()

        if cfg.comparison.run_python:
            logger.info("Running Python benchmark (%s)", lang)
            python_client = TTSClient(
                cfg.server.python_url,
                cfg_eff.model,
                timeout=cfg.server.timeout,
                batch_size=cfg.server.batch_size,
                include_samples=cfg.comparison.round_trip_test,
                num_runs=cfg.comparison.num_runs,
            )
            try:
                python_runs = python_client.synthesize_all(texts)
                python_round_trip = None
                if cfg.comparison.round_trip_test and whisper:
                    python_round_trip = round_trip_single_implementation(
                        texts, python_runs, whisper, "Python"
                    )
                save_single_result(
                    cfg_eff,
                    python_runs[0],
                    "python-native",
                    python_round_trip,
                    result_language=lang,
                )
            finally:
                python_client.close()

        if whisper:
            whisper.close()

    logger.info(
        "Supertonic suite done (per-language files; no cross-language comparison). Config=%s",
        config_path,
    )


def main():
    """Main benchmark execution"""
    parser = argparse.ArgumentParser(description="Run TTS benchmark comparison")
    parser.add_argument(
        "--config",
        type=str,
        default="config/config-chatterbox.yaml",
        help="Path to config file"
    )
    args = parser.parse_args()
    
    # Load configuration
    logger.info(f"Loading config from {args.config}")
    try:
        cfg = Config.from_yaml(args.config)
    except Exception as e:
        logger.error(f"Failed to load config: {e}")
        sys.exit(1)
    
    logger.info("Configuration loaded successfully")

    # Set random seeds for reproducibility
    seed = cfg.comparison.seed
    logger.info(f"Setting random seed: {seed}")
    random.seed(seed)
    np.random.seed(seed)

    # Set torch seed if torch is available (for Whisper if it uses torch backend)
    try:
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass  # torch not available, skip

    if "supertonic" in args.config:
        run_supertonic_benchmark_suite(cfg, args.config)
        logger.info("\n" + "=" * 60)
        logger.info("  Benchmark Complete!")
        logger.info("=" * 60)
        logger.info("Results saved to: benchmarks/results/ (per-language supertonic files)")
        return

    logger.info(f"Loading dataset: {cfg.dataset.name} (language: {cfg.model.language})")
    texts = load_dataset_texts(cfg.dataset, language=cfg.model.language)
    logger.info(f"Loaded {len(texts)} texts for benchmarking")

    if not texts:
        logger.error("No texts loaded, exiting")
        sys.exit(1)

    # Show sample texts
    logger.info("\nSample texts:")
    for i, text in enumerate(texts[:3], 1):
        logger.info(f"  {i}. {text[:80]}...")
    
    results = {}
    round_trip_results = {}
    whisper = None
    
    # Load Whisper model if round-trip test is enabled
    if cfg.comparison.round_trip_test:
        logger.info("\n" + "=" * 60)
        whisper_lang = cfg.model.language[:2] if cfg.model.language else "en"
        logger.info(f"  Loading Whisper Model: {cfg.comparison.whisper_model} (language: {whisper_lang})")
        logger.info("=" * 60)
        try:
            whisper_language = TTS_TO_WHISPER_LANG.get(whisper_lang, whisper_lang)
            whisper = WhisperTranscriber(model_size=cfg.comparison.whisper_model, language=whisper_language)
            whisper.load()
            logger.info("✅ Whisper model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load Whisper model: {e}", exc_info=True)
            logger.warning("Round-trip quality tests will be skipped")
            whisper = None
    
    # Run addon benchmark
    if cfg.comparison.run_addon:
        logger.info("\n" + "=" * 60)
        logger.info("  Running TTS Addon Benchmark")
        logger.info("=" * 60)
        
        try:
            addon_client = TTSClient(
                cfg.server.addon_url,
                cfg.model,
                timeout=cfg.server.timeout,
                batch_size=cfg.server.batch_size,
                include_samples=cfg.comparison.round_trip_test,  # Request samples for round-trip test
                num_runs=cfg.comparison.num_runs  # Number of times to run each text
            )
            
            addon_runs = addon_client.synthesize_all(texts)
            results["addon"] = addon_runs
            
            # Log results for each run
            for run_idx, addon_results in enumerate(addon_runs, 1):
                realtime_speed = (1 / addon_results.avg_rtf) if addon_results.avg_rtf > 0 else 0
                logger.info(f"\nAddon Run {run_idx} Results:")
                logger.info(f"  Implementation: {addon_results.implementation}")
                logger.info(f"  Version: {addon_results.version}")
                logger.info(f"  Model Load Time: {addon_results.load_time_ms:.2f} ms")
                logger.info(f"  Total Generation: {addon_results.total_generation_ms:.2f} ms")
                logger.info(f"  Total Audio: {addon_results.total_audio_duration:.2f} s")
                logger.info(f"  Average RTF: {addon_results.avg_rtf:.4f}")
                logger.info(f"  Speed: {realtime_speed:.2f}x real-time")
            
            addon_client.close()
            
            # Run round-trip quality test for addon if enabled
            addon_round_trip = None
            if cfg.comparison.round_trip_test and whisper:
                logger.info("\n" + "=" * 60)
                logger.info("  Running Addon Round-Trip Quality Test")
                logger.info("=" * 60)
                try:
                    addon_round_trip = round_trip_single_implementation(
                        texts,
                        addon_runs,
                        whisper,
                        "Addon",
                    )
                    if addon_round_trip:
                        round_trip_results["addon"] = addon_round_trip
                        logger.info(f"\n  Addon Quality Metrics (Run 1):")
                        logger.info(f"    WER: {addon_round_trip['runs'][0]['avg_wer']:.2%}")
                        logger.info(f"    CER: {addon_round_trip['runs'][0]['avg_cer']:.2%}")
                        logger.info(f"    Samples tested: {addon_round_trip['total_tested']}")
                except Exception as e:
                    logger.error(f"Addon round-trip test failed: {e}", exc_info=True)
            
            # Save results (use first run for single result file, include round-trip metrics if available)
            save_single_result(cfg, addon_runs[0], "addon", addon_round_trip)
            
        except Exception as e:
            logger.error(f"Addon benchmark failed: {e}", exc_info=True)
            if not cfg.comparison.run_python:
                sys.exit(1)
    
    # Run Python native benchmark
    if cfg.comparison.run_python:
        logger.info("\n" + "=" * 60)
        logger.info("  Running Python Native Benchmark")
        logger.info("=" * 60)
        
        try:
            python_client = TTSClient(
                cfg.server.python_url,
                cfg.model,
                timeout=cfg.server.timeout,
                batch_size=cfg.server.batch_size,
                include_samples=cfg.comparison.round_trip_test,  # Request samples for round-trip test
                num_runs=cfg.comparison.num_runs  # Number of times to run each text
            )
            
            python_runs = python_client.synthesize_all(texts)
            results["python"] = python_runs
            
            # Log results for each run
            for run_idx, python_results in enumerate(python_runs, 1):
                realtime_speed = (1 / python_results.avg_rtf) if python_results.avg_rtf > 0 else 0
                logger.info(f"\nPython Native Run {run_idx} Results:")
                logger.info(f"  Implementation: {python_results.implementation}")
                logger.info(f"  Version: {python_results.version}")
                logger.info(f"  Model Load Time: {python_results.load_time_ms:.2f} ms")
                logger.info(f"  Total Generation: {python_results.total_generation_ms:.2f} ms")
                logger.info(f"  Total Audio: {python_results.total_audio_duration:.2f} s")
                logger.info(f"  Average RTF: {python_results.avg_rtf:.4f}")
                logger.info(f"  Speed: {realtime_speed:.2f}x real-time")
            
            python_client.close()
            
            # Run round-trip quality test for python if enabled
            python_round_trip = None
            if cfg.comparison.round_trip_test and whisper:
                logger.info("\n" + "=" * 60)
                logger.info("  Running Python Round-Trip Quality Test")
                logger.info("=" * 60)
                try:
                    python_round_trip = round_trip_single_implementation(
                        texts,
                        python_runs,
                        whisper,
                        "Python",
                    )
                    if python_round_trip:
                        round_trip_results["python"] = python_round_trip
                        logger.info(f"\n  Python Quality Metrics (Run 1):")
                        logger.info(f"    WER: {python_round_trip['runs'][0]['avg_wer']:.2%}")
                        logger.info(f"    CER: {python_round_trip['runs'][0]['avg_cer']:.2%}")
                        logger.info(f"    Samples tested: {python_round_trip['total_tested']}")
                except Exception as e:
                    logger.error(f"Python round-trip test failed: {e}", exc_info=True)
            
            # Save results (use first run for single result file, include round-trip metrics if available)
            save_single_result(cfg, python_runs[0], "python-native", python_round_trip)
            
        except Exception as e:
            logger.error(f"Python native benchmark failed: {e}", exc_info=True)
            if not cfg.comparison.run_addon:
                sys.exit(1)
    
    # Generate comparison report
    if cfg.comparison.enabled and "addon" in results and "python" in results:
        logger.info("\n" + "=" * 60)
        logger.info("  Generating Comparison Report")
        logger.info("=" * 60)
        
        addon_runs = results["addon"]
        python_runs = results["python"]
        
        # Use first run for summary comparison
        addon_results = addon_runs[0]
        python_results = python_runs[0]
        
        # Calculate comparison metrics (with guards for division by zero)
        speedup = python_results.total_generation_ms / addon_results.total_generation_ms if addon_results.total_generation_ms > 0 else 0
        load_time_diff = ((addon_results.load_time_ms - python_results.load_time_ms) / python_results.load_time_ms) * 100 if python_results.load_time_ms > 0 else 0
        rtf_diff = ((addon_results.avg_rtf - python_results.avg_rtf) / python_results.avg_rtf) * 100 if python_results.avg_rtf > 0 else 0
        
        logger.info("\nComparison Summary (Run 1):")
        logger.info(f"  Model Load Time:")
        logger.info(f"    Addon:  {addon_results.load_time_ms:.2f} ms")
        logger.info(f"    Python: {python_results.load_time_ms:.2f} ms")
        logger.info(f"    Diff:   {load_time_diff:+.1f}%")
        
        logger.info(f"\n  Average RTF:")
        logger.info(f"    Addon:  {addon_results.avg_rtf:.4f}")
        logger.info(f"    Python: {python_results.avg_rtf:.4f}")
        logger.info(f"    Diff:   {rtf_diff:+.1f}%")
        
        logger.info(f"\n  Total Generation Time:")
        logger.info(f"    Addon:  {addon_results.total_generation_ms:.2f} ms")
        logger.info(f"    Python: {python_results.total_generation_ms:.2f} ms")
        logger.info(f"    Speedup: {speedup:.2f}x")
        
        if speedup > 1:
            logger.info(f"\n  ✅ Addon is {speedup:.2f}x FASTER than Python native")
        elif speedup < 1:
            logger.info(f"\n  ⚠️  Addon is {1/speedup:.2f}x SLOWER than Python native")
        else:
            logger.info(f"\n  ➡️  Similar performance")
        
        # Combine round-trip results if both are available
        combined_round_trip = None
        if "addon" in round_trip_results and "python" in round_trip_results:
            combined_round_trip = {
                "addon": round_trip_results["addon"],
                "python": round_trip_results["python"],
                "total_tested": min(
                    round_trip_results["addon"].get("total_tested", 0),
                    round_trip_results["python"].get("total_tested", 0)
                )
            }
            logger.info("\n" + "=" * 60)
            logger.info("  Round-Trip Quality Comparison")
            logger.info("=" * 60)
            logger.info(f"    Addon WER:  {combined_round_trip['addon']['runs'][0]['avg_wer']:.2%}")
            logger.info(f"    Python WER: {combined_round_trip['python']['runs'][0]['avg_wer']:.2%}")
            logger.info(f"    Addon CER:  {combined_round_trip['addon']['runs'][0]['avg_cer']:.2%}")
            logger.info(f"    Python CER: {combined_round_trip['python']['runs'][0]['avg_cer']:.2%}")
        
        save_comparison_report(cfg, addon_runs, python_runs, combined_round_trip)
    
    # Clean up Whisper model
    if whisper:
        whisper.close()
    
    logger.info("\n" + "=" * 60)
    logger.info("  Benchmark Complete!")
    logger.info("=" * 60)
    logger.info(f"Results saved to: benchmarks/results/")


if __name__ == "__main__":
    main()

