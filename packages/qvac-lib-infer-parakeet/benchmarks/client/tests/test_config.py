import pytest
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
            lib="@qvac/transcription-parakeet",
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
                lib="@qvac/transcription-parakeet"
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


class TestModelConfig:
    def test_default_model_type(self):
        # Skip path validation for testing
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


class TestModelTypes:
    def test_all_model_types(self):
        assert ModelType.TDT.value == "tdt"
        assert ModelType.CTC.value == "ctc"
        assert ModelType.EOU.value == "eou"
        assert ModelType.SORTFORMER.value == "sortformer"
