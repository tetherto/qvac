from types import SimpleNamespace

from src.parakeet.client import AddonResults
from src.parakeet.config import DatasetType, Language, ModelType, SpeakerGroup
from src.parakeet import utils


def build_config(model_path, model_type, language, use_gpu=False):
    return SimpleNamespace(
        server=SimpleNamespace(lib="@qvac/asr-ggml", version=None),
        dataset=SimpleNamespace(
            dataset_type=DatasetType.FLEURS,
            speaker_group=SpeakerGroup.CLEAN,
            language=language,
        ),
        model=SimpleNamespace(
            path=model_path,
            model_type=model_type,
            streaming=False,
            use_gpu=use_gpu,
            max_threads=4,
        ),
    )


def build_results():
    return AddonResults(
        transcriptions=["text"],
        load_times_ms=[1.0],
        run_times_ms=[2.0],
        total_load_time_ms=1.0,
        total_run_time_ms=2.0,
        model_version="0.2.0",
    )


def build_streaming_config(model_path, model_type, language):
    config = build_config(model_path, model_type, language)
    config.model.streaming = True
    return config


def test_results_use_runtime_addon_version(tmp_path, monkeypatch):
    monkeypatch.setattr(utils, "_get_results_root", lambda: tmp_path)
    config = build_config(
        "indic-conformer-ctc.q8_0.gguf",
        ModelType.INDIC_CONFORMER,
        Language.HINDI,
    )
    results = build_results()

    utils.save_benchmark_results(config, 1.0, 2.0, results)

    result_path = (
        tmp_path
        / "indic-conformer-ctc.q8_0.gguf"
        / "fleurs-hindi-clean-indic-conformer-cpu-batch.md"
    )
    assert '"@qvac/asr-ggml": "0.2.0"' in result_path.read_text()


def test_summary_includes_all_model_results(tmp_path, monkeypatch):
    monkeypatch.setattr(utils, "_get_results_root", lambda: tmp_path)
    indic_config = build_config(
        "indic-conformer-ctc.q8_0.gguf",
        ModelType.INDIC_CONFORMER,
        Language.HINDI,
    )
    tdt_config = build_config(
        "parakeet-tdt-0.6b-v3.f16.gguf",
        ModelType.TDT,
        Language.ENGLISH,
        use_gpu=True,
    )

    utils.save_benchmark_results(indic_config, 5.37, 2.97, build_results())
    utils.save_benchmark_results(tdt_config, 3.21, 1.23, build_results())
    utils.generate_summary()

    summary = (tmp_path / "results_summary.md").read_text()
    assert "indic-conformer-ctc.q8_0.gguf" in summary
    assert "parakeet-tdt-0.6b-v3.f16.gguf" in summary
    assert "| 5.37 | 2.97 |" in summary
    assert "| 3.21 | 1.23 |" in summary


def test_streaming_results_record_first_partial_latency(tmp_path, monkeypatch):
    monkeypatch.setattr(utils, "_get_results_root", lambda: tmp_path)
    config = build_streaming_config(
        "parakeet-unified-en-0.6b.f16.gguf",
        ModelType.UNIFIED,
        Language.ENGLISH,
    )

    utils.save_benchmark_results(
        config, 2.15, 0.63, build_results(), first_partial={"avg_ms": 421.5, "median_ms": 400.0}
    )

    result_path = (
        tmp_path
        / "parakeet-unified-en-0.6b.f16.gguf"
        / "fleurs-english-clean-unified-cpu-streaming.md"
    )
    text = result_path.read_text()
    assert "- **Avg time to first partial:** 421.50 ms" in text
    assert "- **Median time to first partial:** 400.00 ms" in text


def test_summary_carries_ttfp_for_streaming_rows_only(tmp_path, monkeypatch):
    monkeypatch.setattr(utils, "_get_results_root", lambda: tmp_path)
    streaming_config = build_streaming_config(
        "parakeet-unified-en-0.6b.f16.gguf",
        ModelType.UNIFIED,
        Language.ENGLISH,
    )
    batch_config = build_config(
        "parakeet-tdt-0.6b-v3.f16.gguf",
        ModelType.TDT,
        Language.ENGLISH,
    )

    utils.save_benchmark_results(
        streaming_config,
        2.15,
        0.63,
        build_results(),
        first_partial={"avg_ms": 421.5, "median_ms": 400.0},
    )
    utils.save_benchmark_results(batch_config, 2.26, 0.77, build_results())
    utils.generate_summary()

    summary = (tmp_path / "results_summary.md").read_text()
    assert "| TTFP (ms) |" in summary
    assert "| streaming | 2.15 | 0.63 | 421.50 |" in summary
    assert "| batch | 2.26 | 0.77 |  |" in summary
