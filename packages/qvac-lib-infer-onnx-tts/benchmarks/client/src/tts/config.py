"""Configuration management for TTS benchmarks"""

import yaml
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, HttpUrl, Field


class ServerConfig(BaseModel):
    addon_url: HttpUrl = Field(..., description="URL of addon server")
    addon_version: str = Field("^0.1.0", description="Expected version of @qvac/tts-onnx addon")
    python_url: Optional[HttpUrl] = Field(None, description="URL of python native server")
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
    """Model configuration - supports both Piper TTS and Chatterbox"""
    # Piper TTS fields
    modelPath: Optional[str] = Field(None, description="Path to ONNX model (Piper)")
    configPath: Optional[str] = Field(None, description="Path to model config JSON (Piper)")
    eSpeakDataPath: Optional[str] = Field(None, description="Path to eSpeak-ng data (Piper)")
    
    # Chatterbox fields
    modelDir: Optional[str] = Field(None, description="Path to Chatterbox model directory")
    tokenizerPath: Optional[str] = Field(None, description="Path to tokenizer (Chatterbox)")
    speechEncoderPath: Optional[str] = Field(None, description="Path to speech encoder ONNX (Chatterbox)")
    embedTokensPath: Optional[str] = Field(None, description="Path to embed tokens ONNX (Chatterbox)")
    conditionalDecoderPath: Optional[str] = Field(None, description="Path to conditional decoder ONNX (Chatterbox)")
    languageModelPath: Optional[str] = Field(None, description="Path to language model ONNX (Chatterbox)")
    referenceAudioPath: Optional[str] = Field(None, description="Path to reference audio WAV file (Chatterbox)")
    variant: str = Field("fp32", description="Model variant (Chatterbox)")
    
    # Common fields
    language: str = Field("en", description="Language code")
    sampleRate: int = Field(22050, description="Audio sample rate")
    useGPU: bool = Field(False, description="Enable GPU acceleration for inference")
    
    @property
    def is_chatterbox(self) -> bool:
        """Check if this is a Chatterbox configuration"""
        return self.modelDir is not None or self.tokenizerPath is not None


class Config(BaseModel):
    server: ServerConfig
    comparison: ComparisonConfig
    dataset: DatasetConfig
    model: ModelConfig

    @classmethod
    def from_yaml(cls, path: str = "config/config-tts.yaml") -> "Config":
        """Load configuration from YAML file"""
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return cls(**data)


if __name__ == "__main__":
    # Test config loading
    cfg = Config.from_yaml()
    print(cfg.model_dump_json(indent=2))

