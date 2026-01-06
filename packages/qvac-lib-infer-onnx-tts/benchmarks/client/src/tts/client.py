"""HTTP client for TTS benchmark servers"""

import httpx
import logging
import time
from typing import List, Dict, NamedTuple
from pathlib import Path

from .config import ServerConfig, ModelConfig

# Reduce httpx logging noise
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


class TTSResult(NamedTuple):
    """Result from a single synthesis"""
    text: str
    sample_count: int
    sample_rate: int
    duration_sec: float
    generation_ms: float
    rtf: float
    samples: list = None  # Optional: audio samples for comparison


class TTSResults(NamedTuple):
    """Aggregated results over all texts"""
    results: List[TTSResult]
    implementation: str
    version: str
    load_time_ms: float
    total_generation_ms: float
    
    @property
    def avg_rtf(self) -> float:
        """Calculate average RTF"""
        if not self.results:
            return 0.0
        return sum(r.rtf for r in self.results) / len(self.results)
    
    @property
    def total_audio_duration(self) -> float:
        """Total audio duration in seconds"""
        return sum(r.duration_sec for r in self.results)


class TTSClient:
    """Client for TTS benchmark servers"""
    
    def __init__(self, server_url: str, model_cfg: ModelConfig, timeout: int = 60, batch_size: int = 10, include_samples: bool = False, num_runs: int = 1):
        self.url = str(server_url)
        self.model_cfg = model_cfg
        self.timeout = timeout
        self.batch_size = batch_size
        self.include_samples = include_samples  # Whether to request audio samples
        self.num_runs = num_runs  # Number of times to synthesize each text
        self.client = httpx.Client(timeout=self.timeout)
        
        # Convert paths to absolute, relative to benchmarks/ directory
        # This finds the benchmarks/ directory regardless of where the script is run from
        benchmarks_dir = Path(__file__).resolve().parents[3]  # Go up: tts/ -> src/ -> client/ -> benchmarks/
        
        if not Path(model_cfg.modelPath).is_absolute():
            self.model_cfg.modelPath = str((benchmarks_dir / model_cfg.modelPath).resolve())
        if not Path(model_cfg.configPath).is_absolute():
            self.model_cfg.configPath = str((benchmarks_dir / model_cfg.configPath).resolve())
        if not Path(model_cfg.eSpeakDataPath).is_absolute():
            self.model_cfg.eSpeakDataPath = str((benchmarks_dir / model_cfg.eSpeakDataPath).resolve())
    
    def synthesize_batch(self, texts: List[str]) -> TTSResults:
        """
        Synthesize a batch of texts
        
        Args:
            texts: List of text strings to synthesize
            
        Returns:
            TTSResults with timing and RTF metrics
        """
        logger.info(f"Sending {len(texts)} texts to {self.url}")
        
        request_data = {
            "texts": texts,
            "config": {
                "modelPath": self.model_cfg.modelPath,
                "configPath": self.model_cfg.configPath,
                "eSpeakDataPath": self.model_cfg.eSpeakDataPath,
                "language": self.model_cfg.language,
                "sampleRate": self.model_cfg.sampleRate,
                "useGPU": self.model_cfg.useGPU
            },
            "includeSamples": self.include_samples  # Request samples if needed
        }
        
        resp = self.client.post(self.url, json=request_data)
        resp.raise_for_status()
        
        data = resp.json()
        
        # Parse results
        results = []
        for output in data["outputs"]:
            results.append(TTSResult(
                text=output["text"],
                sample_count=output["sampleCount"],
                sample_rate=output["sampleRate"],
                duration_sec=output["durationSec"],
                generation_ms=output["generationMs"],
                rtf=output["rtf"],
                samples=output.get("samples")  # Optional samples for comparison
            ))
        
        return TTSResults(
            results=results,
            implementation=data["implementation"],
            version=data["version"],
            load_time_ms=data["time"]["loadModelMs"],
            total_generation_ms=data["time"]["totalGenerationMs"]
        )
    
    def synthesize_all(self, texts: List[str]) -> List[TTSResults]:
        """
        Synthesize all texts in batches and aggregate results, running multiple times if configured
        
        Args:
            texts: Full list of texts to synthesize
            
        Returns:
            List of TTSResults (one per run)
        """
        all_runs = []
        
        for run_idx in range(self.num_runs):
            if self.num_runs > 1:
                logger.info(f"\n--- Run {run_idx + 1}/{self.num_runs} ---")
            
            all_results = []
            total_load_time = 0
            total_gen_time = 0
            implementation = None
            version = None
            
            num_batches = (len(texts) + self.batch_size - 1) // self.batch_size
            
            if run_idx == 0:  # Only show this once
                logger.info(f"Synthesizing {len(texts)} texts in {num_batches} batches of {self.batch_size}")
            
            for batch_idx in range(num_batches):
                logger.info(f"Processing batch {batch_idx + 1}/{num_batches}")
                
                start = batch_idx * self.batch_size
                end = start + self.batch_size
                batch = texts[start:end]
                
                # Add retry logic
                max_retries = 3
                retry_delay = 2
                
                for attempt in range(max_retries):
                    try:
                        batch_results = self.synthesize_batch(batch)
                        all_results.extend(batch_results.results)
                        
                        # Accumulate timing (only count load time once)
                        if batch_idx == 0:
                            total_load_time = batch_results.load_time_ms
                        total_gen_time += batch_results.total_generation_ms
                        
                        implementation = batch_results.implementation
                        version = batch_results.version
                        break
                        
                    except (httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.ConnectError) as e:
                        if attempt < max_retries - 1:
                            logger.warning(f"  Error on attempt {attempt + 1}: {e}")
                            logger.warning(f"  Waiting {retry_delay} seconds before retry...")
                            time.sleep(retry_delay)
                        else:
                            logger.error(f"  Failed after {max_retries} attempts")
                            raise
            
            run_results = TTSResults(
                results=all_results,
                implementation=implementation or "unknown",
                version=version or "unknown",
                load_time_ms=total_load_time,
                total_generation_ms=total_gen_time
            )
            all_runs.append(run_results)
        
        return all_runs
    
    def close(self):
        """Close the HTTP client"""
        self.client.close()

