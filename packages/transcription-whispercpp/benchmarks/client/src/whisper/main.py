import argparse
from src.whisper.client import AddonResults, WhisperClient
from src.whisper.config import Config, DatasetType
from src.whisper.dataset.dataset import load_dataset_by_type
from src.whisper.metrics import calculate_wer, calculate_cer, calculate_aradiawer
from src.whisper.utils import save_benchmark_results
from transformers import WhisperProcessor


def main():
    parser = argparse.ArgumentParser(description="Run Whisper transcription benchmark")
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

    sources, references = load_dataset_by_type(cfg.dataset, processor)
    print(f"Loaded {len(sources)} audio data and {len(references)} references")

    if cfg.dataset.max_samples > 0:
        sources = sources[:cfg.dataset.max_samples]
        references = references[:cfg.dataset.max_samples]
        print(f"Limited to {len(sources)} samples based on max_samples configuration")

    client = WhisperClient(cfg.server, cfg.model, processor)
    results = client.transcribe(sources)
    wer_score = None
    cer_score = None
    aradiawer_score = None
    aradiawer_details = None

    print(f"Evaluating {len(results.transcriptions)} transcriptions against {len(references)} references")
    
    if cfg.wer.enabled:
        wer_score = calculate_wer(results.transcriptions, references, language=cfg.dataset.language.value)
        print(f"Calculated WER score: {wer_score:.2f}%")

    if cfg.cer.enabled:
        cer_score = calculate_cer(results.transcriptions, references)
        print(f"Calculated CER score: {cer_score:.2f}%")

    # Calculate AraDiaWER for Arabic language
    if cfg.is_arabic_language() and cfg.aradiawer.enabled:
        aradiawer_score, _, sem_score, syn_score = calculate_aradiawer(
            results.transcriptions, 
            references,
            min_score_threshold=cfg.aradiawer.min_score_threshold
        )
        aradiawer_details = {
            "aradiawer": aradiawer_score,
            "semantic_score": sem_score,
            "syntactic_score": syn_score,
        }
        print(f"Calculated AraDiaWER score: {aradiawer_score:.2f}%")
        print(f"  - Semantic score: {sem_score:.3f}")
        print(f"  - Syntactic score: {syn_score:.3f}")
        if wer_score and wer_score > 0:
            reduction = ((wer_score - aradiawer_score) / wer_score) * 100
            print(f"  - WER reduction: {reduction:.1f}%")

    save_benchmark_results(cfg, wer_score, cer_score, results, aradiawer_details=aradiawer_details)


if __name__ == "__main__":
    main()
