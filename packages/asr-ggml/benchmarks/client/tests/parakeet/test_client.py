from types import SimpleNamespace

from src.parakeet.client import ParakeetClient
from src.parakeet.config import ModelConfig, ModelType, ServerConfig


def build_client(model_config, processor=None):
    server_config = ServerConfig(
        url="http://localhost:8080/run",
        batch_size=1,
        lib="@qvac/asr-ggml",
    )
    return ParakeetClient(server_config, model_config, processor=processor)


def build_streaming_model_config(**overrides):
    fields = {
        "path": "./models/parakeet-unified-en-0.6b.f16.gguf",
        "sample_rate": 16000,
        "model_type": ModelType.UNIFIED,
        "language": None,
        "max_threads": 4,
        "use_gpu": False,
        "caption_enabled": False,
        "timestamps_enabled": True,
        "streaming": True,
        "streaming_chunk_ms": 320,
        "streaming_history_ms": None,
        "streaming_emit_partials": True,
    }
    fields.update(overrides)
    return ModelConfig.model_construct(**fields)


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


def test_run_config_forwards_ms_streaming_controls():
    client = build_client(build_streaming_model_config(streaming_emit_partials=False))

    try:
        config = client.build_run_config()
        assert config["streaming"] is True
        assert config["streamingChunkMs"] == 320
        assert config["streamingEmitPartials"] is False
        assert "streamingHistoryMs" not in config
        assert "streamingChunkSize" not in config
    finally:
        client.close()


def test_run_config_includes_history_when_set():
    client = build_client(build_streaming_model_config(streaming_history_ms=30000))

    try:
        assert client.build_run_config()["streamingHistoryMs"] == 30000
    finally:
        client.close()


def test_response_parsing_collects_first_partial_latencies():
    identity_processor = SimpleNamespace(
        tokenizer=SimpleNamespace(normalize=lambda text: text)
    )
    client = build_client(build_streaming_model_config(), processor=identity_processor)

    payload = {
        "data": {
            "outputs": ["hello world", "second sample"],
            "parakeetVersion": "0.4.2",
            "time": {
                "loadModelMs": 12.0,
                "runMs": 340.0,
                "firstPartialMs": [421.5, None],
            },
        }
    }

    try:
        result = client.parse_run_response(payload)
        assert result.transcriptions == ["hello world", "second sample"]
        assert result.first_partial_ms == [421.5]
        assert result.load_time_ms == 12.0
        assert result.run_time_ms == 340.0
        assert result.model_version == "0.4.2"
    finally:
        client.close()
