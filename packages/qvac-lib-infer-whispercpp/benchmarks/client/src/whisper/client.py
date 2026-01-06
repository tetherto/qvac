import httpx
import logging
import time
from typing import List, NamedTuple
from src.whisper.config import Config, ServerConfig, ModelConfig
from src.whisper.dataset.dataset import load_dataset_by_type
from transformers import WhisperProcessor

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


class AddonResult(NamedTuple):
    """Result of a single transcription batch."""

    transcriptions: List[str]
    load_time_ms: float
    run_time_ms: float
    model_version: str


class AddonResults(NamedTuple):
    """Aggregated result over all batches."""

    transcriptions: List[str]
    load_times_ms: List[float]
    run_times_ms: List[float]
    total_load_time_ms: float
    total_run_time_ms: float
    model_version: str


class WhisperClient:
    def __init__(self, server_cfg: ServerConfig, model_cfg: ModelConfig, processor: WhisperProcessor):
        self.url = str(server_cfg.url)
        self.lib = server_cfg.lib
        self.version = server_cfg.version
        self.timeout = server_cfg.timeout
        self.batch_size = server_cfg.batch_size
        self.model_cfg = model_cfg
        self.processor = processor
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
        whisper_config = {
            "audio_format": self.model_cfg.audio_format,
        }
        
        if self.model_cfg.vad_model_path:
            whisper_config["vad_model_path"] = self.model_cfg.vad_model_path
        
        if self.model_cfg.language:
            whisper_config["language"] = self.model_cfg.language

        resp = self.client.post(
            self.url,
            json={
                "inputs": batch,
                "whisper": {
                    "lib": self.lib,
                    "version": self.version,
                },
                "config": {
                    "path": self.model_cfg.path,
                    "whisperConfig": whisper_config,
                    "sampleRate": self.model_cfg.sample_rate,
                    "streaming": self.model_cfg.streaming,
                    "streamingChunkSize": self.model_cfg.streaming_chunk_size,
                },
            },
        )
        resp.raise_for_status()
        payload = resp.json()

        data = payload.get("data", {})
        outputs = data.get("outputs", [])
        times = data.get("time", {})
        model_version = data.get("whisperVersion", "")

        normalized_outputs = [self.processor.tokenizer.normalize(output) for output in outputs]

        return AddonResult(
            transcriptions=normalized_outputs,
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
        all_transcriptions: List[str] = []
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

            max_retries = 10
            retry_delay = 5
            
            for attempt in range(max_retries):
                try:
                    result = self.transcribe_batch(batch)
                    all_transcriptions.extend(result.transcriptions)
                    load_times.append(result.load_time_ms)
                    run_times.append(result.run_time_ms)
                    break
                except (httpx.RemoteProtocolError, httpx.ReadTimeout) as e:
                    if attempt < max_retries - 1:
                        print(f"  Error on attempt {attempt + 1}: {e}")
                        print(f"  Waiting {retry_delay} seconds before retry...")
                        time.sleep(retry_delay)
                        print(f"  Retrying batch {batch_idx + 1} (attempt {attempt + 2}/{max_retries})")
                    else:
                        print(f"  Failed after {max_retries} attempts")
                        raise

        return AddonResults(
            transcriptions=all_transcriptions,
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
    from transformers import WhisperProcessor
    
    cfg = Config.from_yaml()
    processor = WhisperProcessor.from_pretrained("openai/whisper-tiny")
    client = WhisperClient(cfg.server, cfg.model, processor)

    sources, references = load_dataset_by_type(cfg.dataset, processor)
    sample = sources[:7]
    results = client.transcribe(sample)

    print("refs", references[:7])
    print("results", results.transcriptions[:7])

    print(f"\n Addon execution complete:")
    print(f" • Total transcriptions: {len(results.transcriptions)}")
    print(f" • Load times per batch: {results.load_times_ms}")
    print(f" • Run  times per batch: {results.run_times_ms}")
    print(f" • Total load time: {results.total_load_time_ms:.2f} ms")
    print(f" • Total run  time: {results.total_run_time_ms:.2f} ms")

    client.close()
