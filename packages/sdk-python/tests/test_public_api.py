"""Parity guard for the flat public API (Phase E of the drift plan).

Fails if the flat `tetherto.qvac_sdk` surface stops covering a generated contract method,
if an ergonomic wrapper stops shadowing its generated namesake, or if a
capability the JS `@qvac/sdk` client/api exports loses its Python equivalent.
"""

from __future__ import annotations

import tetherto.qvac_sdk as qvac
import tetherto.qvac_sdk.methods as _methods


def test_every_generated_method_is_reachable_from_flat_qvac():
    # completion_orchestrate is deliberately kept off the flat surface (worker
    # plumbing with no JS client wrapper -- see tetherto/qvac_sdk/__init__.py); it stays
    # reachable as tetherto.qvac_sdk._completion.completion_orchestrate.
    missing = [
        name
        for name in _methods.__all__
        if name != "completion_orchestrate" and not hasattr(qvac, name)
    ]
    assert not missing, f"generated methods missing from flat qvac: {missing}"


def test_completion_orchestrate_is_not_on_the_flat_surface():
    assert not hasattr(qvac, "completion_orchestrate")
    assert "completion_orchestrate" not in qvac.__all__
    from tetherto.qvac_sdk._completion import completion_orchestrate

    assert completion_orchestrate.__module__ == "tetherto.qvac_sdk._completion"


def test_ergonomic_wrappers_shadow_generated_stubs():
    # These names exist as both a generated stub and a hand-written wrapper;
    # the flat surface must resolve to the wrapper, not the raw stub.
    assert qvac.load_model.__module__ == "tetherto.qvac_sdk._api"
    assert qvac.unload_model.__module__ == "tetherto.qvac_sdk._api"
    assert qvac.cancel.__module__ == "tetherto.qvac_sdk._api"
    assert qvac.delete_cache.__module__ == "tetherto.qvac_sdk._api"
    assert qvac.translate.__module__ == "tetherto.qvac_sdk._api"
    assert qvac.model_registry_list.__module__ == "tetherto.qvac_sdk._api"
    assert qvac.model_registry_search.__module__ == "tetherto.qvac_sdk._api"
    assert qvac.model_registry_get_model.__module__ == "tetherto.qvac_sdk._api"
    # completion is a wrapper with no generated namesake (completionStream is).
    assert qvac.completion.__module__ == "tetherto.qvac_sdk._completion"


def test_js_client_api_capabilities_have_python_equivalents():
    # The runtime exports of @qvac/sdk's client/api (index.ts), mapped to their
    # Python names. rag* is JS's 9 helper functions over the single `rag`
    # method; the capability, not each helper, is what's guarded here.
    js_to_python = {
        "batchCompletion": "batch_completion_stream",
        "completion": "completion",
        "deleteCache": "delete_cache",
        "loadModel": "load_model",
        "downloadAsset": "download_asset",
        "heartbeat": "heartbeat",
        "startQVACProvider": "provide",
        "stopQVACProvider": "stop_provide",
        "unloadModel": "unload_model",
        "transcribe": "transcribe",
        "transcribeStream": "transcribe_stream",
        "bciTranscribe": "bci_transcribe",
        "bciTranscribeStream": "bci_transcribe_stream",
        "embed": "embed",
        "finetune": "finetune",
        "translate": "translate",
        "cancel": "cancel",
        "textToSpeech": "text_to_speech",
        "textToSpeechStream": "text_to_speech_stream",
        "getModelInfo": "get_model_info",
        "getLoadedModelInfo": "get_loaded_model_info",
        "loggingStream": "logging_stream",
        "subscribeServerLogs": "subscribe_server_logs",
        "ocr": "ocr_stream",
        "invokePlugin": "invoke_plugin",
        "invokePluginStream": "invoke_plugin_stream",
        "diffusion": "diffusion_stream",
        "classify": "classify",
        "video": "video_stream",
        "upscale": "upscale_stream",
        "modelRegistryList": "model_registry_list",
        "modelRegistrySearch": "model_registry_search",
        "modelRegistryGetModel": "model_registry_get_model",
        "suspend": "suspend",
        "resume": "resume",
        "state": "state",
        "vla": "vla",
        "vlaHparams": "vla_hparams",
        "vlaPreprocessImage": "vla_preprocess_image",
        "vlaPadState": "vla_pad_state",
        "rag*": "rag",
    }
    missing = {js: py for js, py in js_to_python.items() if not hasattr(qvac, py)}
    assert not missing, f"JS client/api capabilities missing from qvac: {missing}"
