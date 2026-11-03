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
python examples/audiogen_cover.py path/to/song.wav "orchestral arrangement"
python examples/audiogen_edit.py path/to/song.wav "original pop song" "guitar pop-rock"
python examples/audiogen_understand.py path/to/song.wav
python examples/plugins.py <model-src>
python examples/vla.py [path-to-smolvla.gguf]
```

`finetune.py` is the exception: it trains on `train.jsonl` and `eval.jsonl` from
this folder, so swap in your own data by replacing those two files.

Models download over P2P from the registry on first use and are cached locally.
`audiogen_minimax.py` is the exception there: MiniMax-Music3 is not in the
registry, so it reads its two GGUF paths from `AUDIOGEN_MINIMAX_LM_MODEL` and
`AUDIOGEN_MINIMAX_SYNTH_MODEL`.

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
| `transcription_parakeet_tdt.py`    | `asr/parakeet-tdt-filesystem.ts`                       | `transcribe` with a Parakeet TDT GGUF (`model_type="parakeet-transcription"`); text frames joined into one transcript    |
| `transcription_parakeet_ctc.py`    | `asr/parakeet-ctc-filesystem.ts`                       | `transcribe` with the English-only Parakeet CTC GGUF; same flow as the TDT port                                           |
| `transcription_parakeet_unified.py` | `asr/parakeet-unified-filesystem.ts`                  | `transcribe` with the English-only Parakeet Unified GGUF, which also serves `transcribe_stream_session`                   |
| `transcription_parakeet_unified_coreml.py` | `asr/parakeet-unified-coreml.ts`               | macOS Core ML sidecar: `get_model_info` + `download_asset` stage five registry files beside a local Unified GGUF          |
| `transcription_parakeet_transcribepsy.py`  | `asr/parakeet-transcribepsy-filesystem.ts`     | TranscribePsy on ggml or `--coreml`; `--window-sec` sets long-form window frames; `stats` read off the closing frame     |
| `transcription_parakeet_indic_conformer.py` | `asr/parakeet-indic-conformer-filesystem.ts`  | Indic Conformer CTC with a required `language` in `model_config`, which masks the vocab to that language                 |
| `transcription_parakeet_sortformer.py` | `asr/parakeet-sortformer.ts`                       | Sortformer diarization, then TDT `transcribe` per speaker segment; `wave` slices the PCM, same-speaker runs are merged   |
| `bci_filesystem.py`                | `bci/bci-filesystem.ts`                                | `bci_transcribe` (`BciTranscribeRequest`) with a `filePath` neural chunk and `metadata: True` segments                   |
| `bci_filesystem_streaming.py`      | `bci/bci-filesystem-streaming.ts`                      | `bci_transcribe_stream_session` with `emit="delta"`; the file is written in 64 KiB chunks while a task drains the session |
| `voice_assistant.py`               | `voice-assistant/voice-assistant.ts`                   | mic → `transcribe_stream_session` (Whisper + Silero VAD) → `completion` → `text_to_speech`; ffmpeg/ffplay helpers inline |
| `text_to_speech.py`                | `tts/supertonic.ts`                                    | `text_to_speech` (`TextToSpeechRequest`)                                                                                  |
| `text_to_speech_parler.py`         | `tts/parler.ts`                                        | Parler-TTS Mini v1 with a `voice` + `seed` in `model_config` and a per-request `emotion`                                 |
| `text_to_speech_cosyvoice3.py`     | `tts/cosyvoice3.ts`                                    | CosyVoice3 with registry companions (flow/HiFT, voice, tokenizer) and a per-request `emotion`                            |
| `text_to_speech_audio8.py`         | `tts/audio8.ts`                                        | Audio8 LM + `audio8CodecDecoderModelSrc`; `stats.codec_on_coreml` reports the codec backend                              |
| `text_to_speech_moss.py`           | `tts/moss.ts`                                          | MOSS-TTS `stream: True` with `streamChunkTokens`; time to first audio, optional `referenceAudioSrc` voice clone          |
| `text_to_speech_moss_dialogue.py`  | `tts/moss-dialogue.ts`                                 | MOSS-TTSD two-speaker dialogue from a local backbone; `dialogueReferenceSrcs` plus `[S1]`/`[S2]` tagged text            |
| `text_to_speech_moss_sound_effect.py` | `tts/moss-sound-effect.ts`                          | MOSS-SoundEffect-v2: `seconds` + `steps` on `text_to_speech`, 48 kHz output                                              |
| `text_to_speech_moss_sound_effect_controls.py` | `tts/moss-sound-effect-controls.ts`        | MOSS-SoundEffect-v2 with `negativePrompt`, `guidance` and `shift`                                                        |
| `text_to_speech_moss_speech.py`    | `tts/moss-speech.ts`                                   | MOSS-Speech `textReply: True`: a text-only answer with an empty PCM buffer                                               |
| `text_to_speech_moss_speech_audio.py` | `tts/moss-speech-audio.ts`                          | MOSS-Speech spoken question (`audio` + `sampleRate`) to a 24 kHz spoken reply; PCM16/float32 WAV read with `struct`     |
| `text_to_speech_chatterbox_enhanced.py` | `tts/chatterbox-enhanced.ts`                      | Chatterbox with `lavasrEnhancerModelSrc`: bandwidth extension to 48 kHz                                                  |
| `text_to_speech_supertonic_enhanced.py` | `tts/supertonic-enhanced.ts`                      | Supertonic with the LavaSR denoiser then enhancer, 48 kHz output                                                         |
| `text_to_speech_chatterbox.py`     | `tts/chatterbox.ts`                                    | Chatterbox with `s3genModelSrc` and optional `referenceAudioSrc` voice cloning; engine-reported `sample_rate` for the WAV |
| `audiogen.py`                      | `audiogen/generate-music.ts`                           | `audio_gen_stream` (`AudioGenStreamRequest`), multi-model AudioGen loading                                                |
| `audiogen_cover.py`                | `audiogen/generate-cover.ts`                           | `audio_gen_stream` with `taskType: "cover-nofsq"`: re-render a source recording, optional timbre `referenceAudio`         |
| `audiogen_edit.py`                 | `audiogen/edit-music.ts`                               | `audio_edit_stream` (`AudioEditStreamRequest`) — an ordered Flow-Edit then Repaint pipeline over one source recording    |
| `audiogen_understand.py`           | `audiogen/understand-music.ts`                         | `audio_understand` (`AudioUnderstandRequest`) — caption, musical metadata and recovered FSQ codes off a recording        |
| `audiogen_minimax.py`              | `audiogen/generate-music-minimax.ts`                   | `audio_gen_stream` on the MiniMax-Music3 engine: a bring-your-own GGUF pair and the MiniMax-only sampling knobs           |
| `diffusion_flux2_klein.py`         | `diffusion-flux2-klein.ts`                             | `diffusion_stream` (`DiffusionStreamRequest`) — split-layout FLUX.2 [klein]; progress, images and stats off one iterator  |
| `diffusion_ideogram.py`            | `diffusion-ideogram.ts`                                | `diffusion_stream` with Ideogram 4's serialized structured caption; split layout with an extra unconditional model        |
| `diffusion_qwen_image_21.py`       | `diffusion-qwen-image-21.ts`                           | `diffusion_stream` with two base64 `init_images` references; Qwen3-VL encoder plus `projectionModelSrc`, RGBA output      |
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
| `assess_model_fit.py`              | `assess-model-fit.ts`                                  | `assess_model_fit` — memory verdicts before any download                                                                  |
| `advisory_model_fit.py`            | `advisory-model-fit.ts`                                | `load_model` with `model_fit_policy`, `logging_stream`, `SDK_LOG_ID`                                                      |
| `sharded_models.py`                | `llamacpp-sharded.ts`                                  | `load_model` with a sharded `model_src`; per-shard progress from `on_progress`'s `shard_info`                             |
| `logging_streams.py`               | `logging-streaming.ts`                                 | `logging_stream`, `SDK_LOG_ID`                                                                                            |
| `logging_global.py`                | `logging-global.ts`                                    | `subscribe_server_logs` fan-in; `config/logging/logging.config.json` passed as `Client(config=...)`                     |
| `profiling_per_call.py`            | `profiling/per-call.ts`                                | `profiled_call` on `embed`, an unprofiled call, and an explicitly disabled `__profiling` meta; prints the `ProfilingReport` |
| `classify_image.py`                | `classification/classify-image.ts`                     | `classify` (`ClassifyRequest`) with a base64 image on the bundled MobileNetV3-Small model (`model_type` only)           |
| `decisions.py`                     | `decisions.ts`                                         | `decide` (`DecideRequest`): choice, score and `noul` questions on one state; optional local GGUF argument               |
| `rerank.py`                        | `rerank.ts`                                            | `rerank` (`RerankRequest`): one score per document, sorted; optional GGUF path or URL argument                          |
| `suspend_resume.py`                | `suspend-resume.ts`                                    | `suspend` / `resume` / `state`; a `completion` while suspended fails with `LIFECYCLE_OPERATION_BLOCKED`                |
| `vla.py`                           | `vla-smolvla.ts`                                       | `vla`, `vla_hparams`, `vla_preprocess_image`, `vla_pad_state`                                                             |
| `vla_pi05.py`                     | `vla-pi05.ts`                                          | π₀.₅: three camera frames, discrete state (empty `state`), required `noise`; per-stage timings                           |
| `vla_groot.py`                    | `vla-groot.ts`                                         | GR00T patch inputs, padded continuous state, hand-laid prompt; optional `vla_set_embodiment` via `QVAC_GROOT_*` env vars |
| `plugins.py`                       | `plugins.ts`                                           | `invoke_plugin`, `invoke_plugin_stream`                                                                                   |
| `notebook.ipynb` / `notebook.py`   | (Python-only)                                          | `notebook.SyncClient` — synchronous, numpy/pandas, live streaming (Jupyter notebook + script)                             |
