# QVAC Python SDK — Examples

Self-contained, runnable ports of the TypeScript SDK examples
(`packages/sdk/examples`). Each file is one `asyncio` script (`async def main()`

- `asyncio.run`) that opens a `Client`, does one thing, and exits.

No example imports another. Helpers like the `print_progress` download printer
are repeated inline, exactly as the TypeScript examples repeat theirs, so a file
copied out of this directory still runs. The docs embed these files verbatim,
and `docs/website` tests that invariant.

Examples use the flat public surface — `from tetherto.qvac_sdk import ...` — plus
model constants from `tetherto.qvac_sdk.models`. Generated request models and raw
method stubs may also be imported explicitly from `tetherto.qvac_sdk.schemas`
and `tetherto.qvac_sdk.methods`.

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
python examples/audiogen.py "lo-fi hip hop, mellow piano" audiogen-output.wav
python examples/plugins.py <model-src>
python examples/vla.py [path-to-smolvla.gguf]
```

`finetune.py` is the exception: it trains on `train.jsonl` and `eval.jsonl` from
this folder, so swap in your own data by replacing those two files.

Models download over P2P from the registry on first use and are cached locally.

A few examples reach for a third-party store rather than a built-in one. Each
guards the lookup and names what to install; today that means `pip install
pymongo` and `pip install sqliteai-vector`, declared together as the `examples`
extra.

## Index

| Example                            | Mirrors (`packages/sdk/examples/…`)                    | Public API shown                                                                                                          |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `quickstart.py`                    | `quickstart.ts`                                        | `load_model`, `completion`, `unload_model`                                                                                |
| `rpc_servers.py`                   | `rpc-server.ts`, `rpc-inference.ts`                    | `start_rpc_server`, `stop_rpc_server`, `discover_rpc_servers`; serving requires a worker configured with the RPC provider |
| `completion_events.py`             | `completion-events.ts`                                 | `completion` typed event stream + `run.final`                                                                             |
| `multi_job_completion.py`          | `multi-job-completion.ts`                              | concurrent `completion` calls on one `parallel`-loaded model; per-request `cancel`                                        |
| `completion_tools.py`              | `tools/llamacpp-native-tools.ts`                       | client-side tool loop via `completion` + `final.tool_calls`                                                               |
| `completion_orchestrate.py`        | `tools/llamacpp-native-tools.ts` (worker-orchestrated) | `completion_orchestrate` with tool `handler`s                                                                             |
| `completion_deferred_tools.py`     | `tools/llamacpp-deferred-tools.ts`                     | `defer_loading` + `group` tools kept out of the prompt; worker-run `tool_search` via `completion_orchestrate`             |
| `kv_cache.py`                      | `kv-cache-example.ts`                                  | `kv_cache` on `completion`: auto-keyed reuse across turns, compared against an uncached replay                            |
| `batch_completion.py`              | `batch-completion.ts`                                  | `batch_completion_stream`: many prompts in one call on a `parallel`-loaded model, grouped by prompt id                    |
| `finetune.py`                      | `finetune/llamacpp-finetune.ts`                        | `finetune_with_progress` LoRA run with per-tick progress; `finetune` with `operation` to pause and resume                 |
| `multimodal.py`                    | `llamacpp-multimodal.ts`                               | image `attachments` on a `completion` history; `projectionModelSrc` loaded alongside the LLM                              |
| `cancel.py`                        | `cancel-by-request-id.ts`                              | `cancel` by `request_id`, `InferenceCancelledError`                                                                       |
| `embeddings.py`                    | `embed-p2p.ts`                                         | `embed` (`EmbedRequest`)                                                                                                  |
| `rag_managed.py`                   | `rag/rag-hyperdb/ingest.ts`                            | `rag` (`RagRequest`) — `ingest`, `search`, `closeWorkspace` against the built-in vector store                             |
| `rag_turbovec.py`                  | `rag/rag-turbovec.ts`                                  | `vector_index` (`VectorIndexRequest`) — TurboVec index over `embed` vectors, with snapshot `write`/`load`                 |
| `rag_mongodb.py`                   | `rag/rag-mongodb.ts`                                   | `embed` into MongoDB Atlas Vector Search: `$vectorSearch` with a pre-filter (needs `pymongo`)                             |
| `rag_sqlite.py`                    | `rag/rag-sqlite.ts`                                    | `embed` into SQLite with the vector extension: quantized `vector_quantize_scan` top-k (needs `sqliteai-vector`)           |
| `translation.py`                   | `translation/translation-llm.ts`                       | `translate`                                                                                                               |
| `transcription.py`                 | `transcription/whispercpp-filesystem.ts`               | `transcribe` (`TranscribeRequest`)                                                                                        |
| `text_to_speech.py`                | `tts/supertonic.ts`                                    | `text_to_speech` (`TextToSpeechRequest`)                                                                                  |
| `audiogen.py`                      | `audiogen/generate-music.ts`                           | `audio_gen_stream` (`AudioGenStreamRequest`), multi-model AudioGen loading                                                |
| `diffusion_flux2_klein.py`         | `diffusion-flux2-klein.ts`                             | `diffusion_stream` (`DiffusionStreamRequest`) — split-layout FLUX.2 [klein]; progress, images and stats off one iterator  |
| `diffusion_ideogram.py`            | `diffusion-ideogram.ts`                                | `diffusion_stream` with Ideogram 4's serialized structured caption; split layout with an extra unconditional model        |
| `diffusion_simple.py`              | `diffusion-simple.ts`                                  | `diffusion_stream` at its smallest: one all-in-one SD 2.x GGUF, prompt only, image read off the stream                    |
| `diffusion_flux2_klein_img2img.py` | `diffusion-flux2-klein-img2img.ts`                     | img2img via `init_image` as base64; FLUX.2 in-context conditioning (`prediction: flux2_flow`)                             |
| `diffusion_esrgan_upscale.py`      | `diffusion-esrgan-upscale.ts`                          | ESRGAN post-processing: `upscaler` in `model_config`, triggered per generation by `upscale` (x4 and x16)                  |
| `diffusion_txt2vid.py`             | `diffusion-txt2vid.ts`                                 | `video_stream` (`VideoStreamRequest`) — split-layout Wan 2.1 T2V; progress, clips and stats off one iterator              |
| `diffusion_img2vid.py`             | `diffusion-img2vid.ts`                                 | `video_stream` in `img2vid` mode: base64 `init_image` first frame, Wan 2.1 I2V with CLIP vision weights                   |
| `diffusion_txt2vid_wan22.py`       | `diffusion-txt2vid-wan22.ts`                           | `video_stream` with Wan 2.2 TI2V-5B Turbo: 32-pixel grid from the Wan 2.2 VAE, distilled 4-step schedule                 |
| `diffusion_txt2vid_ltx.py`         | `diffusion-txt2vid-ltx.ts`                             | `video_stream` with LTX-2: Gemma encoder + connectors layout, `audioVaeModelSrc` for a muxed 48 kHz track                |
| `diffusion_img2vid_ltx.py`         | `diffusion-img2vid-ltx.ts`                             | LTX-2 `img2vid`: the txt2vid layout plus a base64 `init_image`, and no CLIP vision weights                               |
| `diffusion_ic_lora_ltx.py`         | `diffusion-ic-lora-ltx.ts`                             | LTX-2 conditioned on a base64 reference sheet (`reference_images`) with a runtime-applied Ingredients LoRA               |
| `diffusion_txt2vid_minimax_h3.py`  | `diffusion-txt2vid-minimax-h3.ts`                      | MiniMax-H3 `txt2vid` from four local model files, with H3\_\* env placement overrides                                   |
| `diffusion_img2vid_minimax_h3.py`  | `diffusion-img2vid-minimax-h3.ts`                      | MiniMax-H3 `img2vid`: the same local layout minus the audio VAE, plus a base64 `init_image`                              |
| `abot_world.py`                    | `abot-world.ts`                                        | ABot-World session: `world_scene_stream` once, then `world_step_stream` per block, with a block-granular `cancel`         |
| `ocr.py`                           | `ocr-fasttext.ts`                                      | `ocr_stream` (`OcrStreamRequest`)                                                                                         |
| `registry_query.py`                | `registry-query.ts`                                    | `model_registry_list` / `_search` / `_get_model`                                                                          |
| `model_info.py`                    | `cache-management.ts`                                  | `get_model_info`, `download_asset_with_progress`                                                                          |
| `assess_model_fit.py`              | `assess-model-fit.ts`                                  | `assess_model_fit` (`AssessModelFitRequest`) — memory verdicts before any download                                        |
| `advisory_model_fit.py`            | `advisory-model-fit.ts`                                | `load_model` (`LoadModelRequest`) with `modelFitPolicy`, `logging_stream`, `SDK_LOG_ID`                                   |
| `sharded_models.py`                | `llamacpp-sharded.ts`                                  | `load_model` with a sharded `model_src`; per-shard progress from `on_progress`'s `shard_info`                             |
| `logging_streams.py`               | `logging-streaming.ts`                                 | `logging_stream`, `SDK_LOG_ID`                                                                                            |
| `vla.py`                           | `vla-smolvla.ts`                                       | `vla`, `vla_hparams`, `vla_preprocess_image`, `vla_pad_state`                                                             |
| `plugins.py`                       | `plugins.ts`                                           | `invoke_plugin`, `invoke_plugin_stream`                                                                                   |
| `notebook.ipynb` / `notebook.py`   | (Python-only)                                          | `notebook.SyncClient` — synchronous, numpy/pandas, live streaming (Jupyter notebook + script)                             |
