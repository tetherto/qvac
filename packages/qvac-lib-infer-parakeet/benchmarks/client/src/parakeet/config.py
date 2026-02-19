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


class Language(str, Enum):
    ENGLISH = "english"
    FRENCH = "french"
    GERMAN = "german"
    SPANISH = "spanish"
    ITALIAN = "italian"
    PORTUGUESE = "portuguese"
    MANDARIN_CHINESE = "mandarin_chinese"
    RUSSIAN = "russian"
    JAPANESE = "japanese"
    CZECH = "czech"


class ModelType(str, Enum):
    TDT = "tdt"
    CTC = "ctc"
    EOU = "eou"
    SORTFORMER = "sortformer"


class ServerConfig(BaseModel):
    url: HttpUrl = Field(..., description="Server URL")
    timeout: int = Field(60, gt=0, description="HTTP request timeout in seconds")
    batch_size: int = Field(..., gt=0, description="Batch size for transcription")
    lib: str = Field(..., description="Model addon library name")
    version: Optional[str] = Field(None, description="Model addon library version")


class DatasetConfig(BaseModel):
    dataset_type: DatasetType = Field(
        DatasetType.LIBRISPEECH, description="Dataset type (librispeech or fleurs)"
    )
    speaker_group: SpeakerGroup = Field(
        SpeakerGroup.CLEAN, description="Subset of LibriSpeech speakers based on transcript WER (only for LibriSpeech)"
    )
    language: Language = Field(
        Language.ENGLISH, description="Dataset language"
    )
    max_samples: int = Field(0, description="Maximum number of samples to process (0 = unlimited)")


class CERConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate CER score")


class WERConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate WER score")


class ModelConfig(BaseModel):
    path: str = Field("./models/parakeet-tdt-0.6b-v3-onnx", description="Path to the model directory")
    sample_rate: int = Field(16000, description="Audio sample rate")
    audio_format: str = Field("s16le", description="Audio format (s16le or f32le)")
    model_type: ModelType = Field(ModelType.TDT, description="Model type (tdt, ctc, eou, sortformer)")
    max_threads: int = Field(4, gt=0, description="Max CPU threads for inference")
    use_gpu: bool = Field(False, description="Enable GPU acceleration")
    caption_enabled: bool = Field(False, description="Enable caption/subtitle mode")
    timestamps_enabled: bool = Field(True, description="Include timestamps in output")
    streaming: bool = Field(False, description="Enable streaming mode (chunked processing)")
    streaming_chunk_size: int = Field(64000, description="Chunk size in bytes for streaming mode")

    @model_validator(mode='after')
    def validate_paths(self):
        abs_path = os.path.abspath(self.path)
        if not os.path.isdir(self.path):
            raise ValueError(
                f"Model directory not found: {self.path}\n"
                f"Absolute path: {abs_path}\n"
                f"Please ensure the model directory exists before running the benchmark."
            )
        return self


class Config(BaseModel):
    server: ServerConfig
    dataset: DatasetConfig
    cer: CERConfig
    wer: WERConfig
    model: ModelConfig = Field(default_factory=ModelConfig, description="Model configuration")

    @classmethod
    def from_yaml(cls, path: str = "config/config.yaml") -> "Config":
        with open(path, "r", encoding="utf-8") as f:
            return cls(**yaml.safe_load(f))


if __name__ == "__main__":
    cfg = Config.from_yaml()
    print(cfg.model_dump_json(indent=2))
