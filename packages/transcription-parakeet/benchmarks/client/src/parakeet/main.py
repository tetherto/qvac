import argparse
from src.parakeet.client import AddonResults, ParakeetClient
from src.parakeet.config import Config, DatasetType
from src.parakeet.dataset.dataset import load_dataset_by_type
from src.parakeet.metrics import calculate_wer, calculate_cer
from src.parakeet.utils import save_benchmark_results
from transformers import WhisperProcessor


def main():
    parser = argparse.ArgumentParser(description="Run Parakeet transcription benchmark")
    parser.add_argument(
        "--config", type=str, default="config/config.yaml", help="Path to config file"
    )
    args = parser.parse_args()

    cfg = Config.from_yaml(args.config)
    print(f"Loaded config from {args.config}")

    dataset_info = f"{cfg.dataset.dataset_type.value} dataset for language [{cfg.dataset.language.value}]"
    if cfg.dataset.dataset_type == DatasetType.LIBRISPEECH:
        dataset_info += f" (speaker group: {cfg.dataset.speaker_group.value})"
    print(f"Loading {dataset_info}...")
    
    processor = WhisperProcessor.from_pretrained("openai/whisper-tiny")

    sources, references = load_dataset_by_type(cfg.dataset, processor, cfg.model.audio_format)
    print(f"Loaded {len(sources)} audio data and {len(references)} references")

    if cfg.dataset.max_samples > 0:
        sources = sources[:cfg.dataset.max_samples]
        references = references[:cfg.dataset.max_samples]
        print(f"Limited to {len(sources)} samples based on max_samples configuration")

    client = ParakeetClient(cfg.server, cfg.model, processor)
    results = client.transcribe(sources)
    wer_score = None
    cer_score = None

    print(f"Evaluating {len(results.transcriptions)} transcriptions against {len(references)} references")
    
    if cfg.wer.enabled:
        wer_score = calculate_wer(results.transcriptions, references, language=cfg.dataset.language.value)
        print(f"Calculated WER score: {wer_score:.2f}%")

    if cfg.cer.enabled:
        cer_score = calculate_cer(results.transcriptions, references)
        print(f"Calculated CER score: {cer_score:.2f}%")

    save_benchmark_results(cfg, wer_score, cer_score, results)


if __name__ == "__main__":
    main()
