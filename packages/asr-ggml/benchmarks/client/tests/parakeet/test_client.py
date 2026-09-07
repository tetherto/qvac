from src.parakeet.client import ParakeetClient
from src.parakeet.config import ModelConfig, ModelType, ServerConfig


def test_unified_model_type_is_forwarded_without_language():
    server_config = ServerConfig(
        url="http://localhost:8080/run",
        batch_size=1,
        lib="@qvac/asr-ggml",
    )
    model_config = ModelConfig.model_construct(
        path="./models/parakeet-unified-en-0.6b.f16.gguf",
        model_type=ModelType.UNIFIED,
        language=None,
        max_threads=4,
        use_gpu=False,
        caption_enabled=False,
        timestamps_enabled=True,
    )
    client = ParakeetClient(server_config, model_config, processor=None)

    try:
        parakeet_config = client.build_parakeet_config()
        assert parakeet_config["modelType"] == "unified"
        assert "language" not in parakeet_config
    finally:
        client.close()


def test_indic_language_is_forwarded():
    server_config = ServerConfig(
        url="http://localhost:8080/run",
        batch_size=1,
        lib="@qvac/asr-ggml",
    )
    model_config = ModelConfig.model_construct(
        path="./models/indic.gguf",
        model_type=ModelType.INDIC_CONFORMER,
        language="hi",
        max_threads=4,
        use_gpu=False,
        caption_enabled=False,
        timestamps_enabled=True,
    )
    client = ParakeetClient(server_config, model_config, processor=None)

    try:
        assert client.build_parakeet_config()["language"] == "hi"
    finally:
        client.close()
