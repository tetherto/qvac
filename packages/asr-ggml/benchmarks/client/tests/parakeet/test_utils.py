from types import SimpleNamespace

from src.parakeet.client import AddonResults
from src.parakeet.config import DatasetType, Language, ModelType, SpeakerGroup
from src.parakeet import utils


def test_results_use_runtime_addon_version(tmp_path, monkeypatch):
    monkeypatch.setattr(utils, "_get_results_root", lambda: tmp_path)
    config = SimpleNamespace(
        server=SimpleNamespace(lib="@qvac/asr-ggml", version=None),
        dataset=SimpleNamespace(
            dataset_type=DatasetType.FLEURS,
            speaker_group=SpeakerGroup.CLEAN,
            language=Language.HINDI,
        ),
        model=SimpleNamespace(
            path="indic-conformer-ctc.q8_0.gguf",
            model_type=ModelType.INDIC_CONFORMER,
            streaming=False,
            use_gpu=False,
            max_threads=4,
        ),
    )
    results = AddonResults(
        transcriptions=["text"],
        load_times_ms=[1.0],
        run_times_ms=[2.0],
        total_load_time_ms=1.0,
        total_run_time_ms=2.0,
        model_version="0.2.0",
    )

    utils.save_benchmark_results(config, 1.0, 2.0, results)

    result_path = (
        tmp_path
        / "indic-conformer-ctc.q8_0.gguf"
        / "fleurs-hindi-clean-indic-conformer-cpu-batch.md"
    )
    assert '"@qvac/asr-ggml": "0.2.0"' in result_path.read_text()
