import argparse
import mteb
import logging
from src.gte.config import Config
from src.gte.model import EmbeddingsModel
from src.gte.utils import save_benchmark_results, generate_summary


def main():
    parser = argparse.ArgumentParser(description="Run Marian translation benchmark")
    parser.add_argument(
        "--config", type=str, default="config/config.yaml", help="Path to config file"
    )
    parser.add_argument(
        "--max-retries", type=int, default=5, help="Maximum number of retry attempts"
    )
    parser.add_argument(
        "--base-delay",
        type=float,
        default=2.0,
        help="Base delay for exponential backoff (seconds)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
    )

    cfg = Config.from_yaml(args.config)
    print(f"Loaded config from {args.config}")

    model = EmbeddingsModel(
        cfg.server, max_retries=args.max_retries, base_delay=args.base_delay
    )

    try:
        tasks = mteb.get_tasks(tasks=cfg.dataset)
        evaluation = mteb.MTEB(tasks=tasks)

        evaluation.run(
            model,
            encode_kwargs={"batch_size": cfg.server.batch_size},
            output_folder="benchmark_results",
        )

        print("Evaluation complete")
    except Exception as e:
        logging.error(f"Evaluation failed: {e}")
        raise
    finally:
        model.close()

    save_benchmark_results(cfg)
    generate_summary()


if __name__ == "__main__":
    main()
