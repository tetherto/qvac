from pathlib import Path

import pytest
import yaml
from src.parakeet.config import (
    Config,
    ServerConfig,
    DatasetConfig,
    ModelConfig,
    DatasetType,
    SpeakerGroup,
    Language,
    ModelType
)


class TestServerConfig:
    def test_valid_config(self):
        config = ServerConfig(
            url="http://localhost:8080/run",
            timeout=60,
            batch_size=10,
            lib="@qvac/asr-ggml",
            version="0.1.0"
        )
        assert str(config.url) == "http://localhost:8080/run"
        assert config.timeout == 60
        assert config.batch_size == 10

    def test_invalid_timeout(self):
        with pytest.raises(ValueError):
            ServerConfig(
                url="http://localhost:8080/run",
                timeout=0,
                batch_size=10,
                lib="@qvac/asr-ggml"
            )


class TestDatasetConfig:
    def test_default_values(self):
        config = DatasetConfig()
        assert config.dataset_type == DatasetType.LIBRISPEECH
        assert config.speaker_group == SpeakerGroup.CLEAN
        assert config.language == Language.ENGLISH
        assert config.max_samples == 0

    def test_fleurs_dataset(self):
        config = DatasetConfig(
            dataset_type=DatasetType.FLEURS,
            language=Language.MANDARIN_CHINESE
        )
        assert config.dataset_type == DatasetType.FLEURS
        assert config.language == Language.MANDARIN_CHINESE

    @pytest.mark.parametrize(
        "language",
        [Language.HINDI, Language.GUJARATI, Language.KANNADA, Language.TAMIL],
    )
    def test_indic_fleurs_languages(self, language):
        config = DatasetConfig(
            dataset_type=DatasetType.FLEURS,
            language=language,
        )
        assert config.language == language


class TestModelConfig:
    def test_default_model_type(self):
        config = ModelConfig.model_construct(
            path="./models/test",
            model_type=ModelType.TDT
        )
        assert config.model_type == ModelType.TDT

    def test_ctc_model_type(self):
        config = ModelConfig.model_construct(
            path="./models/test",
            model_type=ModelType.CTC
        )
        assert config.model_type == ModelType.CTC

    def test_unified_model_type(self):
        config = ModelConfig.model_construct(
            path="./models/test",
            model_type=ModelType.UNIFIED
        )
        assert config.model_type == ModelType.UNIFIED

    def test_unified_does_not_require_language(self, tmp_path):
        model_path = tmp_path / "unified.gguf"
        model_path.touch()

        config = ModelConfig(
            path=str(model_path),
            model_type=ModelType.UNIFIED,
        )

        assert config.language is None

    def test_indic_conformer_requires_language(self, tmp_path):
        model_path = tmp_path / "indic.gguf"
        model_path.touch()

        with pytest.raises(ValueError, match="requires a model language"):
            ModelConfig(
                path=str(model_path),
                model_type=ModelType.INDIC_CONFORMER,
            )

    def test_indic_conformer_accepts_language(self, tmp_path):
        model_path = tmp_path / "indic.gguf"
        model_path.touch()

        config = ModelConfig(
            path=str(model_path),
            model_type=ModelType.INDIC_CONFORMER,
            language="hi",
        )

        assert config.language == "hi"


class TestModelTypes:
    def test_all_model_types(self):
        assert ModelType.TDT.value == "tdt"
        assert ModelType.UNIFIED.value == "unified"
        assert ModelType.CTC.value == "ctc"
        assert ModelType.EOU.value == "eou"
        assert ModelType.SORTFORMER.value == "sortformer"
        assert ModelType.INDIC_CONFORMER.value == "indic-conformer"


CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"
PARAKEET_CONFIGS = sorted(CONFIG_DIR.glob("config-parakeet*.yaml"))


class TestShippedConfigs:
    def test_parakeet_configs_are_discovered(self):
        assert PARAKEET_CONFIGS, f"no parakeet configs found under {CONFIG_DIR}"

    @pytest.mark.parametrize(
        "config_path", PARAKEET_CONFIGS, ids=lambda path: path.name
    )
    def test_declared_model_type_is_known(self, config_path):
        """Every shipped config must name a model type the client can load.

        The benchmark workflow picks one of these templates per lane and only
        overwrites the values in place, so a config naming an unknown type
        fails at config load, before a single sample is transcribed.
        """
        raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))

        ModelType(raw["model"]["model_type"])
