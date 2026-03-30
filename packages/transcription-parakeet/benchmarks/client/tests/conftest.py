import pytest


@pytest.fixture
def sample_config():
    """Sample configuration for testing."""
    return {
        "server": {
            "url": "http://localhost:8080/run",
            "timeout": 60,
            "batch_size": 10,
            "lib": "@qvac/transcription-parakeet",
            "version": "0.1.0"
        },
        "dataset": {
            "dataset_type": "librispeech",
            "speaker_group": "clean",
            "language": "english",
            "max_samples": 10
        },
        "cer": {"enabled": True},
        "wer": {"enabled": True},
        "model": {
            "path": "./models/parakeet-tdt-0.6b-v3-onnx",
            "sample_rate": 16000,
            "audio_format": "f32le",
            "model_type": "tdt",
            "max_threads": 4,
            "use_gpu": False,
            "caption_enabled": False,
            "timestamps_enabled": True,
            "streaming": False,
            "streaming_chunk_size": 64000
        }
    }
