import argparse
import subprocess
import sys
from src.marian.client import MarianClient
from src.marian.config import Config
from src.marian.dataset import load_flores_dataset
from src.marian.metrics.bleu import calculate_bleu
from src.marian.metrics.comet import calculate_comet
from src.marian.utils import save_benchmark_results, generate_summary


def login_to_huggingface(token: str) -> bool:
    """Login to Hugging Face using the CLI."""
    try:
        subprocess.run(
            ["huggingface-cli", "login", "--token", token],
            capture_output=True,
            text=True,
            check=True,
        )
        print("Successfully logged in to Hugging Face")
        return True
    except subprocess.CalledProcessError as e:
        print(f"Failed to login to Hugging Face: {e.stderr}", file=sys.stderr)
        return False
    except FileNotFoundError:
        print(
            "huggingface-cli not found. Please install it with: pip install huggingface_hub",
            file=sys.stderr,
        )
        return False


def main():
    parser = argparse.ArgumentParser(description="Run Marian translation benchmark")
    parser.add_argument(
        "--config", type=str, default="config/config.yaml", help="Path to config file"
    )
    args = parser.parse_args()

    cfg = Config.from_yaml(args.config)
    print(f"Loaded config from {args.config}")

    # Login to Hugging Face first
    if not login_to_huggingface(cfg.huggingface.token):
        sys.exit(1)

    print(
        f"Loading FLORES+ dataset ({cfg.dataset.src_lang} -> {cfg.dataset.dst_lang})..."
    )
    sources, references = load_flores_dataset(cfg.dataset)
    print(f"Loaded {len(sources)} source sentences and {len(references)} references")

    client = MarianClient(cfg.server, cfg.dataset)
    results = client.translate(sources)
    bleu_score = None
    comet_score = None
    xcomet_score = None

    if cfg.bleu.enabled:
        print("Calculating BLEU score...")
        bleu_score = calculate_bleu(results.translations, references, cfg.bleu)

    if cfg.comet.enabled:
        print("Calculating COMET scores...")
        comet_score, xcomet_score = calculate_comet(
            sources, results.translations, references, cfg.comet
        )

    save_benchmark_results(cfg, bleu_score, comet_score, xcomet_score, results)
    generate_summary()


if __name__ == "__main__":
    main()
