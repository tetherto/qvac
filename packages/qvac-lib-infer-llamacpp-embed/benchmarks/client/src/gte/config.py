import yaml
from typing import Optional, List
from pydantic import BaseModel, HttpUrl, Field


class ServerConfig(BaseModel):
    url: HttpUrl = Field(..., description="Server URL")
    batch_size: int = Field(100, gt=0, description="Batch size")
    timeout: int = Field(0, ge=0, description="HTTP request timeout in seconds")
    lib: str = Field(..., description="Model addon library name")
    version: Optional[str] = Field(None, description="Model addon library version")
    config: Optional[dict] = Field(None, description="Model configuration")

class Config(BaseModel):
    server: ServerConfig
    dataset: List[str] = Field(
        default=[], description="List of dataset names to process"
    )

    @classmethod
    def from_yaml(cls, path: str = "config/config.yaml") -> "Config":
        with open(path, "r", encoding="utf-8") as f:
            return cls(**yaml.safe_load(f))


if __name__ == "__main__":
    cfg = Config.from_yaml()
    print(cfg.model_dump_json(indent=2))
