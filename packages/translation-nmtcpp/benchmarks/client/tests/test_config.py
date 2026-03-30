import pytest
from pathlib import Path
import yaml
from pydantic import ValidationError
from src.marian.config import Config, TokenizerType, SmoothMethod


def write_config(tmp_path: Path, config: dict) -> Path:
    """Write a config dict to a temporary YAML file."""
    config_file = tmp_path / "config.yaml"
    with open(config_file, "w") as f:
        yaml.dump(config, f)
    return config_file


MOCK_CONFIG = {
    "server": {
        "url": "http://localhost:8080/translate",
        "timeout": 90,
        "batch_size": 32,
        "model_id": "test-model-id",
        "hyperdrive_key": "test-hyperdrive-key",
    },
    "huggingface": {
        "token": "hf_sample_token",
    },
    "dataset": {
        "src_lang": "eng_Latn",
        "dst_lang": "deu_Latn",
    },
    "bleu": {
        "enabled": True,
        "smooth_method": "exp",
        "smooth_value": None,
        "lowercase": False,
        "tokenizer": None,
        "force_tokenize": True,
        "use_effective_order": False,
    },
    "comet": {
        "enabled": True,
        "batch_size": None,
        "gpus": None,
    },
}


def test_loads_valid_config(tmp_path):
    """Config.from_yaml should succeed with a minimal valid config."""
    config_file = write_config(tmp_path, MOCK_CONFIG)
    cfg = Config.from_yaml(path=str(config_file))
    assert str(cfg.server.url) == MOCK_CONFIG["server"]["url"]
    assert cfg.server.batch_size == 32
    assert cfg.server.model_id == "test-model-id"
    assert cfg.server.hyperdrive_key == "test-hyperdrive-key"
    assert cfg.huggingface.token == "hf_sample_token"
    assert cfg.dataset.src_lang == "eng_Latn"
    assert cfg.dataset.dst_lang == "deu_Latn"
    assert cfg.bleu.lowercase is False
    assert cfg.bleu.force_tokenize is True
    assert cfg.bleu.tokenizer == TokenizerType.FLORES200
    assert cfg.bleu.smooth_method == SmoothMethod.EXP
    assert cfg.comet.enabled is True
    assert cfg.comet.batch_size == 16
    assert cfg.comet.gpus == 1


@pytest.mark.parametrize(
    "tokenizer_value,expected",
    [
        ("zh", TokenizerType.ZH),
        ("13a", TokenizerType.THIRTEEN_A),
        ("intl", TokenizerType.INTL),
        ("char", TokenizerType.CHAR),
        ("ja-mecab", TokenizerType.JA_MECAB),
        ("ko-mecab", TokenizerType.KO_MECAB),
        ("spm", TokenizerType.SPM),
        ("flores101", TokenizerType.FLORES101),
        ("flores200", TokenizerType.FLORES200),
        (None, TokenizerType.FLORES200),
    ],
)
def test_tokenizer_enum_values(tokenizer_value, expected, tmp_path):
    """Test that all tokenizer enum values are properly handled."""
    config = {**MOCK_CONFIG}
    config["bleu"]["tokenizer"] = tokenizer_value
    config_file = write_config(tmp_path, config)
    cfg = Config.from_yaml(path=str(config_file))
    assert cfg.bleu.tokenizer == expected


@pytest.mark.parametrize(
    "smooth_method_value,expected",
    [
        ("floor", SmoothMethod.FLOOR),
        ("add-k", SmoothMethod.ADD_K),
        ("exp", SmoothMethod.EXP),
        (None, SmoothMethod.EXP),
    ],
)
def test_smooth_method_enum_values(smooth_method_value, expected, tmp_path):
    """Test that all smooth method enum values are properly handled."""
    config = {**MOCK_CONFIG}
    config["bleu"]["smooth_method"] = smooth_method_value
    config_file = write_config(tmp_path, config)
    cfg = Config.from_yaml(path=str(config_file))
    assert cfg.bleu.smooth_method == expected


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
        # Missing huggingface section
        ({**MOCK_CONFIG, "huggingface": None}, "huggingface"),
        # Wrong src_lang length
        (
            {**MOCK_CONFIG, "dataset": {**MOCK_CONFIG["dataset"], "src_lang": "eng"}},
            "src_lang",
        ),
        # Wrong dst_lang length
        (
            {**MOCK_CONFIG, "dataset": {**MOCK_CONFIG["dataset"], "dst_lang": "deu"}},
            "dst_lang",
        ),
        # Missing bleu section
        ({key: MOCK_CONFIG[key] for key in MOCK_CONFIG if key != "bleu"}, "bleu"),
        # Invalid tokenizer value
        (
            {
                **MOCK_CONFIG,
                "bleu": {**MOCK_CONFIG["bleu"], "tokenizer": "invalid-tokenizer"},
            },
            "tokenizer",
        ),
        # Invalid smooth method value
        (
            {
                **MOCK_CONFIG,
                "bleu": {**MOCK_CONFIG["bleu"], "smooth_method": "invalid-method"},
            },
            "smooth_method",
        ),
        # Invalid comet config
        (
            {**MOCK_CONFIG, "comet": {**MOCK_CONFIG["comet"], "enabled": "not-a-bool"}},
            "comet",
        ),
        # Invalid comet xcomet
        (
            {**MOCK_CONFIG, "comet": {**MOCK_CONFIG["comet"], "xcomet": "not-a-bool"}},
            "xcomet",
        ),
        # Invalid comet batch_size
        (
            {
                **MOCK_CONFIG,
                "comet": {**MOCK_CONFIG["comet"], "batch_size": "not-an-int"},
            },
            "batch_size",
        ),
        # Invalid comet gpus
        (
            {**MOCK_CONFIG, "comet": {**MOCK_CONFIG["comet"], "gpus": "not-an-int"}},
            "gpus",
        ),
    ],
)
def test_invalid_configs_raise_validation_error(bad_cfg, error_field, tmp_path):
    """Config.from_yaml should raise ValidationError for bad configs."""
    config_file = write_config(tmp_path, bad_cfg)
    with pytest.raises(ValidationError) as excinfo:
        Config.from_yaml(path=str(config_file))
    assert error_field in str(excinfo.value)
