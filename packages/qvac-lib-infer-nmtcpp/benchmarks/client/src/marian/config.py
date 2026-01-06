import yaml
from enum import Enum
from typing import Optional
from pydantic import BaseModel, HttpUrl, Field, model_validator


class TokenizerType(str, Enum):
    ZH = "zh"
    THIRTEEN_A = "13a"
    INTL = "intl"
    CHAR = "char"
    JA_MECAB = "ja-mecab"
    KO_MECAB = "ko-mecab"
    SPM = "spm"
    FLORES101 = "flores101"
    FLORES200 = "flores200"


class SmoothMethod(str, Enum):
    FLOOR = "floor"
    ADD_K = "add-k"
    EXP = "exp"


class ServerConfig(BaseModel):
    url: HttpUrl = Field(..., description="Server URL")
    timeout: int = Field(90, gt=0, description="HTTP request timeout in seconds")
    batch_size: int = Field(..., gt=0, description="Batch size for translation")
    model_id: str = Field(..., description="Model identifier")
    hyperdrive_key: str = Field(..., description="Hyperdrive key for model access")


class HuggingFaceConfig(BaseModel):
    token: str = Field(..., description="HuggingFace token")

class DatasetConfig(BaseModel):
    src_lang: str = Field(
        ...,
        pattern=r"^[a-z]{3}_[a-zA-Z]{4}$",
        description="Source language in ISO 639-3_ISO 15924 format (e.g. eng_Latn)",
    )
    dst_lang: str = Field(
        ...,
        pattern=r"^[a-z]{3}_[a-zA-Z]{4}$",
        description="Destination language in ISO 639-3_ISO 15924 format (e.g. deu_Latn)",
    )


class BleuConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate BLEU score")
    smooth_method: Optional[SmoothMethod] = Field(
        SmoothMethod.EXP, description="Smoothing method"
    )
    smooth_value: Optional[float] = Field(
        None, description="Smoothing value (only used for add-k)"
    )
    lowercase: Optional[bool] = Field(default=False, description="Lowercase the text")
    tokenizer: Optional[TokenizerType] = Field(
        TokenizerType.FLORES200, description="Tokenizer type"
    )
    force_tokenize: Optional[bool] = Field(
        False, description="Force tokenization even if tokenizer is None"
    )
    use_effective_order: Optional[bool] = Field(
        False, description="Use effective order for n-gram matching"
    )

    @model_validator(mode="after")
    def set_defaults(self) -> "BleuConfig":
        """Set default values for null fields."""
        if self.smooth_method is None:
            self.smooth_method = SmoothMethod.EXP
        if self.tokenizer is None:
            self.tokenizer = TokenizerType.FLORES200
        if self.lowercase is None:
            self.lowercase = False
        if self.force_tokenize is None:
            self.force_tokenize = False
        if self.use_effective_order is None:
            self.use_effective_order = False
        return self


class CometConfig(BaseModel):
    enabled: bool = Field(True, description="Calculate COMET scores")
    xcomet: bool = Field(False, description="Include XCOMET scores")
    batch_size: Optional[int] = Field(
        16, gt=0, description="Batch size for comet model"
    )
    gpus: Optional[int] = Field(1, gt=0, description="Number of GPUs to use")

    @model_validator(mode="after")
    def set_defaults(self) -> "CometConfig":
        """Set default values for null fields."""
        if self.batch_size is None:
            self.batch_size = 16
        if self.gpus is None:
            self.gpus = 1
        return self


class Config(BaseModel):
    server: ServerConfig
    huggingface: HuggingFaceConfig
    dataset: DatasetConfig
    bleu: BleuConfig
    comet: CometConfig

    @classmethod
    def from_yaml(cls, path: str = "config/config.yaml") -> "Config":
        with open(path, "r", encoding="utf-8") as f:
            return cls(**yaml.safe_load(f))


if __name__ == "__main__":
    cfg = Config.from_yaml()
    print(cfg.model_dump_json(indent=2))
