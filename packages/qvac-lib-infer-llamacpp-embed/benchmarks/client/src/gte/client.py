# HTTP send/receive wrapper

import httpx
import logging
import time
import random
from typing import List, NamedTuple
from src.gte.config import Config, ServerConfig

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


class EmbeddingsResult(NamedTuple):
    """Result of a single embedding batch."""

    embeddings: List[List[float]]
    load_time_ms: float
    run_time_ms: float
    model_version: str


class EmbeddingsResults(NamedTuple):
    """Aggregated result over all batches."""

    embeddings: List[List[float]]
    load_times_ms: List[float]
    run_times_ms: List[float]
    total_load_time_ms: float
    total_run_time_ms: float
    model_version: str


class EmbeddingsClient:
    def __init__(
        self, server_cfg: ServerConfig, max_retries: int = 3, base_delay: float = 1.0
    ):
        self.url = str(server_cfg.url)
        self.lib = server_cfg.lib
        self.version = server_cfg.version
        self.config = server_cfg.config
        self.timeout = (
            httpx.Timeout(None)
            if server_cfg.timeout == 0
            else httpx.Timeout(server_cfg.timeout)
        )
        self.batch_size = server_cfg.batch_size
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.client = httpx.Client(timeout=self.timeout)

    def _retry_with_backoff(self, func, *args, **kwargs):
        """
        Retry a function with exponential backoff.

        Args:
            func: Function to retry
            *args: Arguments for the function
            **kwargs: Keyword arguments for the function

        Returns:
            Result of the function call

        Raises:
            Exception: If all retries are exhausted
        """
        last_exception = None

        for attempt in range(self.max_retries + 1):
            try:
                return func(*args, **kwargs)
            except (
                httpx.RemoteProtocolError,
                httpx.ConnectError,
                httpx.ReadTimeout,
                httpx.WriteTimeout,
            ) as e:
                last_exception = e

                if attempt == self.max_retries:
                    raise last_exception

                # Calculate delay with exponential backoff and jitter
                delay = self.base_delay * (2**attempt) + random.uniform(0, 1)

                logging.warning(
                    f"Request failed (attempt {attempt + 1}/{self.max_retries + 1}): {type(e).__name__}: {e}. "
                    f"Retrying in {delay:.2f} seconds..."
                )

                time.sleep(delay)

                # Recreate client if connection was lost
                if isinstance(e, (httpx.RemoteProtocolError, httpx.ConnectError)):
                    try:
                        self.client.close()
                    except:
                        pass
                    self.client = httpx.Client(timeout=self.timeout)

            except Exception as e:
                raise e

        raise last_exception

    def embed_batch(self, batch: List[str]) -> EmbeddingsResult:
        """
        Send one batch of sentences to the server and return embeddings.

        Args:
            batch (List[str]): List of source sentences up to batch_size

        Returns:
            EmbeddingsResult: Named tuple containing:
                - embeddings: List of embeddings
                - load_time_ms: Model load time in milliseconds
                - run_time_ms: Embedding run time in milliseconds

        Raises:
            httpx.HTTPStatusError: for non-2xx responses
            httpx.RequestError: for network issues
        """

        def _make_request():
            payload = {
                "inputs": batch,
                "lib": self.lib,
                "version": self.version,
            }
            
            # Add config if available  
            if self.config:
                payload["config"] = self.config
                
            resp = self.client.post(
                self.url,
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()

        payload = self._retry_with_backoff(_make_request)

        data = payload.get("data", {})
        outputs = data.get("outputs", [])
        times = data.get("time", {})
        model_version = data.get("version", "")

        return EmbeddingsResult(
            embeddings=outputs,
            model_version=model_version,
            load_time_ms=times.get("loadModelMs", 0.0),
            run_time_ms=times.get("runMs", 0.0),
        )

    def embed(self, sources: List[str]) -> EmbeddingsResults:
        """
        Embed all source sentences in batches, then aggregate.

        Args:
            sources (List[str]): Full list of source sentences

        Returns:
            EmbeddingsResults: all embeddings + per-batch times + totals + model version
        """
        all_embeddings: List[List[float]] = []
        load_times: List[float] = []
        run_times: List[float] = []

        num_batches = (len(sources) + self.batch_size - 1) // self.batch_size

        print(
            f"Embedding {len(sources)} sentences in {num_batches} batches of {self.batch_size} sentences..."
        )
        for batch_idx in range(num_batches):
            print(f"Embedding batch {batch_idx + 1} of {num_batches}")
            start = batch_idx * self.batch_size
            end = start + self.batch_size
            batch = sources[start:end]

            result = self.embed_batch(batch)

            all_embeddings.extend(result.embeddings)
            load_times.append(result.load_time_ms)
            run_times.append(result.run_time_ms)
        return EmbeddingsResults(
            embeddings=all_embeddings,
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
    client = EmbeddingsClient(cfg.server)

    src_sentences = ["Hello, world!"] * 100
    sample = src_sentences[:32]
    results = client.embed(sample)

    print(f"\nEmbedding complete:")
    print(f" • Total sentences: {len(results.embeddings)}")
    print(f" • Load times per batch: {results.load_times_ms}")
    print(f" • Run  times per batch: {results.run_times_ms}")
    print(f" • Total load time: {results.total_load_time_ms:.2f} ms")
    print(f" • Total run  time: {results.total_run_time_ms:.2f} ms")

    client.close()
