import pytest
from pathlib import Path
import yaml
from pydantic import ValidationError
from src.whisper.config import (
    Config,
    ServerConfig,
    DatasetConfig,
    SpeakerGroup,
    VADConfig,
)


def write_config(tmp_path: Path, config: dict) -> Path:
    """Write a config dict to a temporary YAML file."""
    config_file = tmp_path / "config.yaml"
    with open(config_file, "w") as f:
        yaml.dump(config, f)
    return config_file


MOCK_CONFIG = {
    "server": {
        "url": "http://localhost:8080/run",
        "batch_size": 32,
        "lib": "@tetherto/qvac-lib-inference-addon-mlc-whisper-tiny-q0f32",
        "version": "1.1.3",
    },
    "dataset": {
        "speaker_group": "all",
    },
    "wer": {
        "enabled": True,
    },
    "cer": {
        "enabled": True,
    },
    "vad": {
        "enabled": True,
        "lib": "@tetherto/qvac-lib-inference-addon-onnx-silerovad",
        "version": "0.4.3",
    },
}


def test_loads_valid_config(tmp_path):
    """Config.from_yaml should succeed with a minimal valid config."""
    config_file = write_config(tmp_path, MOCK_CONFIG)
    cfg = Config.from_yaml(path=str(config_file))
    assert str(cfg.server.url) == MOCK_CONFIG["server"]["url"]
    assert cfg.server.batch_size == 32
    assert cfg.server.version == "1.1.3"
    assert cfg.dataset.speaker_group == SpeakerGroup.ALL
    assert cfg.wer.enabled is True
    assert cfg.cer.enabled is True
    assert cfg.vad.enabled is True
    assert cfg.vad.lib == "@tetherto/qvac-lib-inference-addon-onnx-silerovad"
    assert cfg.vad.version == "0.4.3"


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
        # Invalid speaker_group value
        (
            {
                **MOCK_CONFIG,
                "dataset": {**MOCK_CONFIG["dataset"], "speaker_group": "invalid"},
            },
            "speaker_group",
        ),
        # Missing wer section
        ({key: MOCK_CONFIG[key] for key in MOCK_CONFIG if key != "wer"}, "wer"),
        # Invalid wer enabled value
        (
            {**MOCK_CONFIG, "wer": {**MOCK_CONFIG["wer"], "enabled": "not-a-bool"}},
            "enabled",
        ),
        # Missing cer section
        ({key: MOCK_CONFIG[key] for key in MOCK_CONFIG if key != "cer"}, "cer"),
        # Invalid cer enabled value
        (
            {**MOCK_CONFIG, "cer": {**MOCK_CONFIG["cer"], "enabled": "not-a-bool"}},
            "enabled",
        ),
        # Invalid vad section
        ({key: MOCK_CONFIG[key] for key in MOCK_CONFIG if key != "vad"}, "vad"),
        # Invalid vad enabled value
        (
            {**MOCK_CONFIG, "vad": {**MOCK_CONFIG["vad"], "enabled": "not-a-bool"}},
            "enabled",
        ),
    ],
)
def test_invalid_configs_raise_validation_error(bad_cfg, error_field, tmp_path):
    """Config.from_yaml should raise ValidationError for bad configs."""
    config_file = write_config(tmp_path, bad_cfg)
    with pytest.raises(ValidationError) as excinfo:
        Config.from_yaml(path=str(config_file))
    assert error_field in str(excinfo.value)


def test_config_from_yaml():
    """Test loading config from yaml file."""
    cfg = Config.from_yaml()
    assert isinstance(cfg, Config)
    assert isinstance(cfg.server, ServerConfig)
    assert isinstance(cfg.dataset, DatasetConfig)
    assert isinstance(cfg.vad, VADConfig)
    assert isinstance(cfg.dataset.speaker_group, SpeakerGroup)
    assert cfg.wer.enabled is True
    assert cfg.cer.enabled is True
    assert cfg.vad.enabled is False
    assert cfg.vad.lib == "@tetherto/qvac-lib-inference-addon-onnx-silerovad"
    assert cfg.vad.version == "0.4.3"


def test_server_config():
    """Test server config validation."""
    with pytest.raises(ValueError):
        ServerConfig(
            url="invalid_url",
            lib="@tetherto/qvac-lib-inference-addon-mlc-whisper-tiny-q0f32",
            version="1.1.3",
            batch_size=32,
        )

    cfg = ServerConfig(
        url="http://localhost:8080/run",
        lib="@tetherto/qvac-lib-inference-addon-mlc-whisper-tiny-q0f32",
        version="1.1.3",
        batch_size=32,
    )
    assert str(cfg.url) == "http://localhost:8080/run"
    assert cfg.lib == "@tetherto/qvac-lib-inference-addon-mlc-whisper-tiny-q0f32"
    assert cfg.version == "1.1.3"
    assert cfg.batch_size == 32


def test_dataset_config():
    """Test dataset config validation."""
    cfg = DatasetConfig(speaker_group=SpeakerGroup.ALL)
    assert cfg.speaker_group == SpeakerGroup.ALL

    cfg = DatasetConfig(speaker_group=SpeakerGroup.CLEAN)
    assert cfg.speaker_group == SpeakerGroup.CLEAN

    cfg = DatasetConfig(speaker_group=SpeakerGroup.OTHER)
    assert cfg.speaker_group == SpeakerGroup.OTHER


def test_vad_config():
    """Test VAD config validation."""
    from src.whisper.config import VADConfig

    cfg = VADConfig(enabled=False)
    assert cfg.enabled is False
    assert cfg.lib is None
    assert cfg.version is None

    cfg = VADConfig(enabled=True, lib="test_lib", version="1.0.0")
    assert cfg.enabled is True
    assert cfg.lib == "test_lib"
    assert cfg.version == "1.0.0"

    with pytest.raises(ValueError, match="lib is required when VAD is enabled"):
        VADConfig(enabled=True, version="1.0.0")

    with pytest.raises(ValueError, match="version is required when VAD is enabled"):
        VADConfig(enabled=True, lib="test_lib")

    with pytest.raises(ValueError, match="lib is required when VAD is enabled"):
        VADConfig(enabled=True)
