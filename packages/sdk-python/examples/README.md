# QVAC Python SDK — Examples

Self-contained, runnable ports of the TypeScript SDK examples
(`packages/sdk/examples`). Each file is one `asyncio` script (`async def main()`
+ `asyncio.run`) that opens a `Client`, does one thing, and exits.

Every example imports only from the flat public surface — `from tetherto.qvac_sdk import ...`
— plus model constants from `tetherto.qvac_sdk.models`. Request models (e.g. `EmbedRequest`)
are re-exported from `tetherto.qvac_sdk` too.

## Running

You need a worker (the transport a `Client` talks to):

- **Bundled wheel** — zero config. `Client()` just works.
- **Thin install** — install the worker with `python -m tetherto.qvac_sdk install-worker`,
  or point `QVAC_SDK_DIR` at a built `@qvac/sdk`.

```bash
python examples/quickstart.py
```

Examples that read a local file take it as an argument:

```bash
python examples/transcription.py path/to/audio-16khz.wav
python examples/ocr.py path/to/image.png
python examples/plugins.py <model-src>
python examples/vla.py [path-to-smolvla.gguf]
```

Models download over P2P from the registry on first use and are cached locally.

## Index

| Example | Mirrors (`packages/sdk/examples/…`) | Public API shown |
|---------|-------------------------------------|------------------|
| `quickstart.py` | `quickstart.ts` | `load_model`, `completion`, `unload_model` |
| `completion_events.py` | `completion-events.ts` | `completion` typed event stream + `run.final` |
| `completion_tools.py` | `tools/llamacpp-native-tools.ts` | client-side tool loop via `completion` + `final.tool_calls` |
| `completion_orchestrate.py` | `tools/llamacpp-native-tools.ts` (worker-orchestrated) | `completion_orchestrate` with tool `handler`s |
| `cancel.py` | `cancel-by-request-id.ts` | `cancel` by `request_id`, `InferenceCancelledError` |
| `embeddings.py` | `embed-p2p.ts` | `embed` (`EmbedRequest`) |
| `translation.py` | `translation/translation-llm.ts` | `translate` |
| `transcription.py` | `transcription/whispercpp-filesystem.ts` | `transcribe` (`TranscribeRequest`) |
| `text_to_speech.py` | `tts/supertonic.ts` | `text_to_speech` (`TextToSpeechRequest`) |
| `ocr.py` | `ocr-fasttext.ts` | `ocr_stream` (`OcrStreamRequest`) |
| `registry_query.py` | `registry-query.ts` | `model_registry_list` / `_search` / `_get_model` |
| `model_info.py` | `cache-management.ts` | `get_model_info`, `download_asset_with_progress` |
| `logging_streams.py` | `logging-streaming.ts` | `logging_stream`, `SDK_LOG_ID` |
| `vla.py` | `vla-smolvla.ts` | `vla`, `vla_hparams`, `vla_preprocess_image`, `vla_pad_state` |
| `plugins.py` | `plugins.ts` | `invoke_plugin`, `invoke_plugin_stream` |
| `notebook.ipynb` / `notebook.py` | (Python-only) | `notebook.SyncClient` — synchronous, numpy/pandas, live streaming (Jupyter notebook + script) |
| `_common.py` | (shared `onProgress` printer) | `print_progress` helper |
