import argparse
from pathlib import Path
from src.client import AddonResults, SileroVADClient
from src.config import Config
from src.dataset.dataset import load_aishell_4_dataset

# Import our new modules
from src.vad_metrics import calculate_vad_metrics
from src.reports_summary import generate_results_summary


def main():
    parser = argparse.ArgumentParser(description="Run sileroVAD benchmark with comprehensive evaluation")
    parser.add_argument(
        "--config", type=str, default="config/config.yaml", help="Path to config file"
    )
    parser.add_argument(
        "--output-dir", type=str, default="results", help="Directory to save evaluation results"
    )
    parser.add_argument(
        "--cleanup", action="store_true", help="Clean up temporary output files after evaluation"
    )
    parser.add_argument(
        "--no-reports", action="store_true", help="Skip generating detailed reports (only print summary)"
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable verbose output"
    )
    args = parser.parse_args()

    # Load configuration
    cfg = Config.from_yaml(args.config)
    if args.verbose:
        print(f"Loaded config from {args.config}")

    # Load dataset
    print("Loading AISHELL-4 test dataset...")
    sources, vad_references, vad_timestamps = load_aishell_4_dataset()
    print(f"Loaded {len(sources)} audio files and {len(vad_references)} VAD references")

    # Run the VAD addon
    print("Running SileroVAD addon...")
    client = SileroVADClient(cfg.server)

    try:
        raw_results = client.transcribe(sources)

        results = AddonResults(
            vad_results=raw_results.vad_results,  # This contains output file paths
            load_times_ms=raw_results.load_times_ms,
            run_times_ms=raw_results.run_times_ms,
            total_load_time_ms=raw_results.total_load_time_ms,
            total_run_time_ms=raw_results.total_run_time_ms,
            model_version=raw_results.model_version,
        )

        print(f"Addon completed. Processing {len(results.vad_results)} output files...")

        # Ensure we have matching number of predictions and references
        min_count = min(len(results.vad_results), len(vad_references))
        vad_predictions = results.vad_results[:min_count]
        vad_references = vad_references[:min_count]

        print(f"\nEvaluating VAD performance on {min_count} files...")

        # Calculate evaluation metrics using our new module
        metrics = calculate_vad_metrics(vad_predictions, vad_references, verbose=args.verbose)

        if 'error' in metrics:
            print(f"Error: {metrics['error']}")
            return

        # Prepare model information for reports
        model_info = {
            'model_version': results.model_version,
            'model_name': 'SileroVAD',
            'dataset': 'AISHELL-4 Test Set',
            'total_load_time_ms': results.total_load_time_ms,
            'total_run_time_ms': results.total_run_time_ms,
            'files_total': len(sources)
        }

        # Prepare configuration information
        config_info = {
            'sample_rate': '16kHz',
            'frame_rate': '32Hz (31.25ms frames)',
            'batch_size': cfg.server.batch_size,
            'timeout': cfg.server.timeout,
            'server_url': str(cfg.server.url)
        }

        # Generate reports if requested
        if not args.no_reports:
            print(f"\nGenerating detailed reports...")

            # Create output path for the markdown report
            output_path = Path(args.output_dir) / "results_summary.md"

            # Generate markdown report
            report_path = generate_results_summary(
                metrics=metrics,
                model_info=model_info,
                config_info=config_info,
                output_path=str(output_path),
                verbose=args.verbose
            )

            # Print report location
            print(f"\nGenerated Report:")
            print(f"  MARKDOWN: {report_path}")

        # Cleanup temporary files if requested
        if args.cleanup:
            print(f"\nCleaning up temporary files...")
            cleanup_count = 0
            for file_path in results.vad_results:
                if isinstance(file_path, str) and Path(file_path).exists():
                    try:
                        Path(file_path).unlink()
                        cleanup_count += 1
                    except Exception as e:
                        if args.verbose:
                            print(f"Warning: Could not delete {file_path}: {e}")
            print(f"Cleaned up {cleanup_count} temporary files")

        # Final summary
        print("\n" + "=" * 60)
        print("EVALUATION SUMMARY")
        print("=" * 60)
        print(f"Successfully processed {metrics['files_processed']} files")
        print(f"Overall Accuracy: {metrics.get('overall_accuracy', 0):.1%}")
        print(f"Speech F1-Score: {metrics.get('speech_f1', 0):.1%}")
        print(f"Total Processing Time: {results.total_run_time_ms:.0f}ms")

        if not args.no_reports:
            print(f"Report saved to: {report_path}")

        print("Evaluation complete!")

    except Exception as e:
        print(f"Error during evaluation: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()

    finally:
        client.close()


if __name__ == "__main__":
    main()
