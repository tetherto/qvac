import argparse
from src.whisper.client import AddonResults, WhisperClient
from src.whisper.config import Config
from src.whisper.dataset.dataset import load_librispeech_dataset
from src.whisper.metrics import calculate_wer, calculate_cer
from src.whisper.utils import save_benchmark_results, generate_summary
from transformers import WhisperProcessor


def main():
    parser = argparse.ArgumentParser(description="Run Marian translation benchmark")
    parser.add_argument(
        "--config", type=str, default="config/config.yaml", help="Path to config file"
    )
    args = parser.parse_args()

    cfg = Config.from_yaml(args.config)
    print(f"Loaded config from {args.config}")

    print(
        f"Loading Librispeech dataset for speaker group [{cfg.dataset.speaker_group.value}]..."
    )
    processor = WhisperProcessor.from_pretrained("openai/whisper-tiny")

    sources, references = load_librispeech_dataset(cfg.dataset, processor)
    print(f"Loaded {len(sources)} audio data and {len(references)} references")

    client = WhisperClient(cfg.server, cfg.vad, processor)
    results = client.transcribe(sources)
    wer_score = None
    cer_score = None

    if cfg.wer.enabled:
        print("Calculating WER score...")
        wer_score = calculate_wer(results.transcriptions, references)

    if cfg.cer.enabled:
        print("Calculating CER score...")
        cer_score = calculate_cer(results.transcriptions, references)

    save_benchmark_results(cfg, wer_score, cer_score, results)
    generate_summary()


if __name__ == "__main__":
    main()
