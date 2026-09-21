"""Engine dispatcher for the asr-ggml benchmark client.

Reads the top-level ``engine:`` key from the YAML config and delegates to the
engine-specific benchmark module (``src.whisper.main`` / ``src.parakeet.main``).
There is no engine sniffing: a config without an explicit ``engine`` key is an
error.

Usage:
    poetry run python -u -m src.main --config config/config-whisper.yaml
    poetry run python -u -m src.main --config config/config-parakeet.yaml
"""

import argparse
import sys

import yaml

ENGINES = ("whisper", "parakeet")


def main():
    parser = argparse.ArgumentParser(
        description="Run an asr-ggml transcription benchmark (whisper or parakeet)"
    )
    parser.add_argument(
        "--config",
        type=str,
        default="config/config-whisper.yaml",
        help="Path to config file (must carry a top-level `engine:` key)",
    )
    args = parser.parse_args()

    with open(args.config, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    engine = raw.get("engine")
    if engine not in ENGINES:
        print(
            f"Error: config {args.config} must set a top-level `engine:` key "
            f"to one of {list(ENGINES)} (got: {engine!r}).",
            file=sys.stderr,
        )
        sys.exit(2)

    if engine == "whisper":
        from src.whisper.main import main as engine_main
    else:
        from src.parakeet.main import main as engine_main

    engine_main(args.config)


if __name__ == "__main__":
    main()
