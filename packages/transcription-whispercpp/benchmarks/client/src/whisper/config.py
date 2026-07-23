import yaml
import os
from enum import Enum
from typing import Optional
from pydantic import BaseModel, HttpUrl, Field, model_validator


class SpeakerGroup(str, Enum):
    CLEAN = "clean"
    OTHER = "other"
    ALL = "all"


class DatasetType(str, Enum):
    LIBRISPEECH = "librispeech"
    FLEURS = "fleurs"
    COMMON_VOICE = "common_voice"


class Language(str, Enum):
    ENGLISH = "english"
    FRENCH = "french"
    GERMAN = "german"
    SPANISH = "spanish"
    ITALIAN = "italian"
    PORTUGUESE = "portuguese"
    MANDARIN_CHINESE = "mandarin_chinese"
    ARABIC = "arabic"
    RUSSIAN = "russian"
    JAPANESE = "japanese"
    CZECH = "czech"


class ServerConfig(BaseModel):
    url: HttpUrl = Field(..., description="Server URL")
    timeout: int = Field(90, gt=0, description="HTTP request timeout in seconds")
    batch_size: int = Field(..., gt=0, description="Batch size for translation")
    lib: str = Field(..., description="Model addon library name")
    version: Optional[str] = Field(None, description="Model addon library version")


class DatasetConfig(BaseModel):
    dataset_type: DatasetType = Field(
        DatasetType.LIBRISPEECH, description="Dataset type (librispeech, fleurs, or common_voice)"
    )
    speaker_group: SpeakerGroup = Field(
        SpeakerGroup.CLEAN, description="Subset of LibriSpeech speakers based on transcript WER (only for LibriSpeech)"
    )
    language: Language = Field(
        Language.ENGLISH, description="Dataset language"
    )
    max_samples: int = Field(0, description="Maximum number of samples to process (0 = unlimited)")
    common_voice_manifest: Optional[str] = Field(
        None, description="Path to Common Voice manifest.json file (required for common_voice dataset type)"
    )


class CERConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate CER score")


class WERConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate WER score")


class AraDiaWERConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate AraDiaWER score (auto-enabled for Arabic)")
    min_score_threshold: float = Field(
        0.5, 
        ge=0.0, 
        le=1.0, 
        description="Minimum threshold for semantic/syntactic scores to avoid unstable weights"
    )


class ModelConfig(BaseModel):
    path: str = Field("./examples/ggml-tiny.bin", description="Path to the model file")
    sample_rate: int = Field(16000, description="Audio sample rate")
    audio_format: str = Field("f32le", description="Audio format (f32le or s16le)")
    vad_model_path: Optional[str] = Field(None, description="Path to VAD model file")
    language: str = Field("", description="Language code (empty for auto-detect)")
    streaming: bool = Field(False, description="Enable streaming mode (chunked processing)")
    streaming_chunk_size: int = Field(16384, description="Chunk size in bytes for streaming mode")

    @model_validator(mode='after')
    def validate_paths(self):
        abs_path = os.path.abspath(self.path)
        if not os.path.isfile(self.path):
            raise ValueError(
                f"Model file not found: {self.path}\n"
                f"Absolute path: {abs_path}\n"
                f"Please ensure the model file exists before running the benchmark."
            )
        
        if self.vad_model_path:
            abs_vad_path = os.path.abspath(self.vad_model_path)
            if not os.path.isfile(self.vad_model_path):
                raise ValueError(
                    f"VAD model file not found: {self.vad_model_path}\n"
                    f"Absolute path: {abs_vad_path}\n"
                    f"Please ensure the VAD model file exists before running the benchmark."
                )
        
        return self


class Config(BaseModel):
    server: ServerConfig
    dataset: DatasetConfig
    cer: CERConfig
    wer: WERConfig
    aradiawer: AraDiaWERConfig = Field(
        default_factory=AraDiaWERConfig, 
        description="AraDiaWER configuration (for Arabic dialects)"
    )
    model: ModelConfig = Field(default_factory=ModelConfig, description="Model configuration")

    @classmethod
    def from_yaml(cls, path: str = "config/config.yaml") -> "Config":
        with open(path, "r", encoding="utf-8") as f:
            return cls(**yaml.safe_load(f))
    
    def is_arabic_language(self) -> bool:
        """Check if the configured language is Arabic."""
        return self.dataset.language == Language.ARABIC


if __name__ == "__main__":
    cfg = Config.from_yaml()
    print(cfg.model_dump_json(indent=2))
