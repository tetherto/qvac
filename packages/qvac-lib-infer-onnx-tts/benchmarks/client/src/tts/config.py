"""Configuration management for TTS benchmarks"""

import yaml
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, HttpUrl, Field


class ServerConfig(BaseModel):
    addon_url: HttpUrl = Field(..., description="URL of addon server")
    addon_version: str = Field("^0.1.0", description="Expected version of @qvac/tts-onnx addon")
    python_url: HttpUrl = Field(..., description="URL of python native server")
    timeout: int = Field(60, gt=0, description="HTTP request timeout in seconds")
    batch_size: int = Field(10, gt=0, description="Batch size for synthesis")


class ComparisonConfig(BaseModel):
    enabled: bool = Field(True, description="Run comparison between implementations")
    run_addon: bool = Field(True, description="Run addon server benchmarks")
    run_python: bool = Field(True, description="Run python native benchmarks")
    round_trip_test: bool = Field(False, description="Use Whisper to transcribe audio and measure accuracy")
    whisper_model: str = Field("base", description="Whisper model size (tiny, base, small, medium, large)")
    seed: int = Field(42, description="Random seed for reproducibility")
    num_runs: int = Field(1, ge=1, le=10, description="Number of times to synthesize each text (for variance testing)")


class DatasetConfig(BaseModel):
    name: str = Field("lj_speech", description="Dataset name")
    split: str = Field("test", description="Dataset split")
    max_samples: int = Field(0, ge=0, description="Max samples to process (0 = unlimited)")


class ModelConfig(BaseModel):
    modelPath: str = Field(..., description="Path to ONNX model")
    configPath: str = Field(..., description="Path to model config JSON")
    eSpeakDataPath: str = Field(..., description="Path to eSpeak-ng data")
    language: str = Field("en", description="Language code")
    sampleRate: int = Field(22050, description="Audio sample rate")
    useGPU: bool = Field(False, description="Enable GPU acceleration for inference")


class Config(BaseModel):
    server: ServerConfig
    comparison: ComparisonConfig
    dataset: DatasetConfig
    model: ModelConfig

    @classmethod
    def from_yaml(cls, path: str = "config/config.yaml") -> "Config":
        """Load configuration from YAML file"""
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return cls(**data)


if __name__ == "__main__":
    # Test config loading
    cfg = Config.from_yaml()
    print(cfg.model_dump_json(indent=2))

