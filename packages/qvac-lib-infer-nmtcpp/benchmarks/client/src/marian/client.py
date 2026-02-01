# HTTP send/receive wrapper

import httpx
import logging
from typing import List, NamedTuple
from src.marian.config import Config, ServerConfig, DatasetConfig
from src.marian.dataset import load_flores_dataset
from iso639 import Lang

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


class MarianClient:
    def __init__(self, server_cfg: ServerConfig, dataset_cfg: DatasetConfig):
        self.url = str(server_cfg.url)
        self.timeout = server_cfg.timeout
        self.model_id = server_cfg.model_id
        self.hyperdrive_key = server_cfg.hyperdrive_key
        self.src_lang = dataset_cfg.src_lang.split("_")[0]
        self.dst_lang = dataset_cfg.dst_lang.split("_")[0]
        self.batch_size = server_cfg.batch_size
        self.client = httpx.Client(timeout=self.timeout)

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
        request_data = {
            "inputs": batch,
            "modelId": self.model_id,
            "hyperDriveKey": self.hyperdrive_key,
            "params": {
                "srcLang": Lang(self.src_lang).pt1,  # iso639-2 language code
                "dstLang": Lang(self.dst_lang).pt1,  # iso639-2 language code
            },
        }
        
        resp = self.client.post(self.url, json=request_data)
        resp.raise_for_status()
        payload = resp.json()

        # Parse the response format - server wraps in "data"
        data = payload.get("data", {})
        outputs = data.get("outputs", [])
        times = data.get("time", {})
        version = data.get("version", "unknown")
        
        return TranslationResult(
            translations=outputs,
            model_version=version,  # Use SDK version from server
            load_time_ms=times.get("loadedMs", 0.0),
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
    client = MarianClient(cfg.server, cfg.dataset)

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
