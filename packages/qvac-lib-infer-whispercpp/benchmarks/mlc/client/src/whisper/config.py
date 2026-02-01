import yaml
from enum import Enum
from typing import Optional
from pydantic import BaseModel, HttpUrl, Field, model_validator


class SpeakerGroup(str, Enum):
    CLEAN = "clean"
    OTHER = "other"
    ALL = "all"


class ServerConfig(BaseModel):
    url: HttpUrl = Field(..., description="Server URL")
    timeout: int = Field(90, gt=0, description="HTTP request timeout in seconds")
    batch_size: int = Field(..., gt=0, description="Batch size for translation")
    lib: str = Field(..., description="Model addon library name")
    version: Optional[str] = Field(None, description="Model addon library version")


class DatasetConfig(BaseModel):
    speaker_group: SpeakerGroup = Field(
        ..., description="Subset of LibriSpeech speakers based on transcript WER"
    )


class CERConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate CER score")


class WERConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate WER score")


// Removed top-level VAD config


class Config(BaseModel):
    server: ServerConfig
    dataset: DatasetConfig
    cer: CERConfig
    wer: WERConfig

    @classmethod
    def from_yaml(cls, path: str = "config/config.yaml") -> "Config":
        with open(path, "r", encoding="utf-8") as f:
            return cls(**yaml.safe_load(f))


if __name__ == "__main__":
    cfg = Config.from_yaml()
    print(cfg.model_dump_json(indent=2))
