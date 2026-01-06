import httpx
import logging
from typing import List, NamedTuple
from src.config import Config, ServerConfig
from src.dataset.dataset import load_aishell_4_dataset

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


class AddonResult(NamedTuple):
    """Result of a single transcription batch."""

    vad_results: List[List[int]]
    load_time_ms: float
    run_time_ms: float
    model_version: str


class AddonResults(NamedTuple):
    """Aggregated result over all batches."""

    vad_results: List[List[int]]
    load_times_ms: List[float]
    run_times_ms: List[float]
    total_load_time_ms: float
    total_run_time_ms: float
    model_version: str


class SileroVADClient:
    def __init__(self, server_cfg: ServerConfig):
        self.url = str(server_cfg.url)
        self.lib = server_cfg.lib
        self.version = server_cfg.version
        self.timeout = server_cfg.timeout
        self.batch_size = server_cfg.batch_size
        self.client = httpx.Client(timeout=self.timeout)

    def transcribe_batch(self, batch: List[str]) -> AddonResult:
        """
        Send one batch of audio data to the server and return transcriptions.

        Args:
            batch (List[str]): List of raw audio data paths up to batch_size

        Returns:
            AddonResult: Named tuple containing:
                - transcriptions: List of transcriptions
                - load_time_ms: Model load time in milliseconds
                - run_time_ms: Transcription run time in milliseconds

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
                "params": {},
                "config": {
                    "sampleRate": 16000,
                },
            },
        )
        resp.raise_for_status()
        payload = resp.json()

        data = payload.get("data", {})
        outputs = data.get("outputFiles", [])
        times = data.get("time", {})
        model_version = data.get("version", "")

        return AddonResult(
            vad_results=outputs,
            model_version=model_version,
            load_time_ms=times.get("loadModelMs", 0.0),
            run_time_ms=times.get("runMs", 0.0),
        )

    def transcribe(self, sources: List[str]) -> AddonResults:
        """
        Execute the addon on all source audio data in batches, then aggregate.

        Args:
            sources (List[str]): Full list of paths to source audio data

        Returns:
            AddonResults: all transcriptions + per-batch times + totals + model version
        """
        all_vad_results: List[List[int]] = []
        load_times: List[float] = []
        run_times: List[float] = []

        num_batches = (len(sources) + self.batch_size - 1) // self.batch_size

        print(
            f"Transcribing {len(sources)} audio data in {num_batches} batches of {self.batch_size} audio data..."
        )
        for batch_idx in range(num_batches):
            print(f"Transcribing batch {batch_idx + 1} of {num_batches}")
            start = batch_idx * self.batch_size
            end = start + self.batch_size
            batch = sources[start:end]

            print(f"batch: {batch}")
            result = self.transcribe_batch(batch)

            all_vad_results.extend(result.vad_results)
            load_times.append(result.load_time_ms)
            run_times.append(result.run_time_ms)

        return AddonResults(
            vad_results=all_vad_results,
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
    client = SileroVADClient(cfg.server)

    sources, vad_references, vad_timestamps = load_aishell_4_dataset()
    sample = sources[:7]
    print(sample)

    results = client.transcribe(sample)

    # print("refs", vad_references[:7])
    print("results", results.vad_results[:7])


    print(f"\n Addon execution complete:")
    for ref in vad_references[:7]:
        print(len(ref))
    print(f" • Total transcriptions: {len(results.vad_results)}")
    print(f" • Load times per batch: {results.load_times_ms}")
    print(f" • Run  times per batch: {results.run_times_ms}")
    print(f" • Total load time: {results.total_load_time_ms:.2f} ms")
    print(f" • Total run  time: {results.total_run_time_ms:.2f} ms")

    client.close()
