import pytest
from pathlib import Path
import yaml
from pydantic import ValidationError
from src.gte.config import Config


def write_config(tmp_path: Path, config: dict) -> Path:
    """Write a config dict to a temporary YAML file."""
    config_file = tmp_path / "config.yaml"
    with open(config_file, "w") as f:
        yaml.dump(config, f)
    return config_file


MOCK_CONFIG = {
    "server": {
        "url": "http://localhost:8080/run",
        "timeout": 90,
        "batch_size": 32,
        "lib": "@tetherto/qvac-lib-inference-embeddings-mlc",
        "version": "2.0.0",
    },
    "dataset": ["NQ", "FiQA2018", "FEVER"],
}


def test_loads_valid_config(tmp_path):
    """Config.from_yaml should succeed with a minimal valid config."""
    config_file = write_config(tmp_path, MOCK_CONFIG)
    cfg = Config.from_yaml(path=str(config_file))
    assert str(cfg.server.url) == MOCK_CONFIG["server"]["url"]
    assert cfg.server.batch_size == 32
    assert cfg.server.version == "1.0.0"
    assert cfg.server.lib == MOCK_CONFIG["server"]["lib"]
    assert cfg.dataset == ["NQ", "FiQA2018", "FEVER"]


def test_loads_config_with_empty_dataset(tmp_path):
    """Config.from_yaml should succeed with empty dataset list."""
    config = {**MOCK_CONFIG}
    config["dataset"] = []
    config_file = write_config(tmp_path, config)
    cfg = Config.from_yaml(path=str(config_file))
    assert cfg.dataset == []


def test_loads_config_without_dataset(tmp_path):
    """Config.from_yaml should succeed without dataset field (uses default)."""
    config = {**MOCK_CONFIG}
    del config["dataset"]
    config_file = write_config(tmp_path, config)
    cfg = Config.from_yaml(path=str(config_file))
    assert cfg.dataset == []


@pytest.mark.parametrize(
    "bad_cfg, error_field",
    [
        # Missing server section
        ({**MOCK_CONFIG, "server": None}, "server"),
        # Invalid URL type
        (
            {**MOCK_CONFIG, "server": {**MOCK_CONFIG["server"], "url": "not-a-url"}},
            "url",
        ),
        # Invalid version type
        (
            {**MOCK_CONFIG, "server": {**MOCK_CONFIG["server"], "version": True}},
            "version",
        ),
        # Invalid batch_size type
        (
            {
                **MOCK_CONFIG,
                "server": {**MOCK_CONFIG["server"], "batch_size": "not-an-int"},
            },
            "batch_size",
        ),
        # Invalid batch_size value (must be > 0)
        (
            {**MOCK_CONFIG, "server": {**MOCK_CONFIG["server"], "batch_size": 0}},
            "batch_size",
        ),
        # Invalid timeout type
        (
            {
                **MOCK_CONFIG,
                "server": {**MOCK_CONFIG["server"], "timeout": "not-an-int"},
            },
            "timeout",
        ),
        # Invalid timeout value (must be >= 0)
        (
            {**MOCK_CONFIG, "server": {**MOCK_CONFIG["server"], "timeout": -1}},
            "timeout",
        ),
        # Invalid dataset type (not a list)
        (
            {**MOCK_CONFIG, "dataset": "not-a-list"},
            "dataset",
        ),
        # Invalid dataset type (list with non-string elements)
        (
            {**MOCK_CONFIG, "dataset": ["NQ", 123, "FEVER"]},
            "dataset",
        ),
    ],
)
def test_invalid_configs_raise_validation_error(bad_cfg, error_field, tmp_path):
    """Config.from_yaml should raise ValidationError for bad configs."""
    config_file = write_config(tmp_path, bad_cfg)
    with pytest.raises(ValidationError) as excinfo:
        Config.from_yaml(path=str(config_file))
    assert error_field in str(excinfo.value)


def test_server_config_defaults():
    """Test that server config uses appropriate defaults."""
    config = {
        "server": {
            "url": "http://localhost:8080/run",
            "lib": "@tetherto/qvac-lib-inference-embeddings-mlc",
        }
    }
    cfg = Config(**config)
    assert cfg.server.batch_size == 100
    assert cfg.server.timeout == 0
    assert cfg.server.version is None


def test_config_serialization():
    """Test that config can be serialized and deserialized."""
    cfg = Config(**MOCK_CONFIG)
    serialized = cfg.model_dump()
    assert str(serialized["server"]["url"]) == str(MOCK_CONFIG["server"]["url"])
    assert serialized["server"]["batch_size"] == MOCK_CONFIG["server"]["batch_size"]
    assert serialized["dataset"] == MOCK_CONFIG["dataset"]
