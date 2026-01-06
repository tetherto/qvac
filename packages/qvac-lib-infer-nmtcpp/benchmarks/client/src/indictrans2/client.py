# HTTP send/receive wrapper

import httpx
import logging
from typing import List, NamedTuple
from src.indictrans2.config import Config, ServerConfig, DatasetConfig
from src.indictrans2.dataset import load_flores_dataset

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


class TranslationResult(NamedTuple):
    """Result of a single translation batch."""

    translations: List[str]
    load_time_ms: float
    run_time_ms: float
    model_version: str


class TranslationResults(NamedTuple):
    """Aggregated result over all batches."""

    translations: List[str]
    load_times_ms: List[float]
    run_times_ms: List[float]
    total_load_time_ms: float
    total_run_time_ms: float
    model_version: str


class IndicTransClient:
    def __init__(self, server_cfg: ServerConfig, dataset_cfg: DatasetConfig):
        self.url = str(server_cfg.url)
        self.lib = server_cfg.lib
        self.version = server_cfg.version
        self.timeout = server_cfg.timeout
        self.src_lang = dataset_cfg.src_lang
        self.dst_lang = dataset_cfg.dst_lang
        self.batch_size = server_cfg.batch_size
        self.client = httpx.Client(timeout=None)

    def translate_batch(self, batch: List[str]) -> TranslationResult:
        """
        Send one batch of sentences to the server and return translations.

        Args:
            batch (List[str]): List of source sentences up to batch_size

        Returns:
            TranslationResult: Named tuple containing:
                - translations: List of translated sentences
                - load_time_ms: Model load time in milliseconds
                - run_time_ms: Translation run time in milliseconds

        Raises:
            httpx.HTTPStatusError: for non-2xx responses
            httpx.RequestError: for network issues
        """
        resp = self.client.post(
            self.url,
            json={
                "inputs": batch,
                "lib": self.lib,
                "version": self.version,
                "params": {
                    "mode": "full",
                    "srcLang": self.src_lang,  # iso639-2 language code
                    "dstLang": self.dst_lang,  # iso639-2 language code
                },
            },
        )
        resp.raise_for_status()
        payload = resp.json()

        data = payload.get("data", {})
        outputs = data.get("outputs", [])
        times = data.get("time", {})
        model_version = data.get("version", "")

        return TranslationResult(
            translations=outputs,
            model_version=model_version,
            load_time_ms=times.get("loadModelMs", 0.0),
            run_time_ms=times.get("runMs", 0.0),
        )

    def translate(self, sources: List[str]) -> TranslationResults:
        """
        Translate all source sentences in batches, then aggregate.

        Args:
            sources (List[str]): Full list of source sentences

        Returns:
            TranslationResults: all translations + per-batch times + totals + model version
        """
        all_translations: List[str] = []
        load_times: List[float] = []
        run_times: List[float] = []

        num_batches = (len(sources) + self.batch_size - 1) // self.batch_size

        print(
            f"Translating {len(sources)} sentences in {num_batches} batches of {self.batch_size} sentences..."
        )
        for batch_idx in range(num_batches):
            print(f"Translating batch {batch_idx + 1} of {num_batches}")
            start = batch_idx * self.batch_size
            end = start + self.batch_size
            batch = sources[start:end]

            result = self.translate_batch(batch)

            all_translations.extend(result.translations)
            load_times.append(result.load_time_ms)
            run_times.append(result.run_time_ms)
        return TranslationResults(
            translations=all_translations,
            load_times_ms=load_times,
            run_times_ms=run_times,
            total_load_time_ms=sum(load_times),
            total_run_time_ms=sum(run_times),
            model_version=result.model_version,
        )

    def close(self) -> None:
        """
        Close the underlying HTTP client.
        """
        self.client.close()


if __name__ == "__main__":
    cfg = Config.from_yaml()
    client = IndicTransClient(cfg.server, cfg.dataset)

    src_sentences, _ = load_flores_dataset(cfg.dataset)
    sample = src_sentences[:32]
    results = client.translate(sample)

    print(f"\n Translation complete:")
    print(f" • Total sentences: {len(results.translations)}")
    print(f" • Load times per batch: {results.load_times_ms}")
    print(f" • Run  times per batch: {results.run_times_ms}")
    print(f" • Total load time: {results.total_load_time_ms:.2f} ms")
    print(f" • Total run  time: {results.total_run_time_ms:.2f} ms")

    client.close()
