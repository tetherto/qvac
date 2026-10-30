# QVAC Kotlin SDK — Examples

Self-contained, runnable Kotlin ports of the SDK examples. Each file in `src/`
is one desktop JVM program (`fun main(): Unit = runBlocking { ... }`) that opens
a `QvacClient`, does one thing, and exits.

No example imports another. Helpers like the download-progress printer and the
WAV writer are repeated inline as private functions, so a file copied out of
this directory still builds. The build enforces that: each file is its own
source set, compiled only against the SDK. The docs embed these files verbatim.

On Android, connect with `AndroidServiceTransport.connect(context)` instead of
`JvmBareRpcTransport.connectResolved(...)`; the rest of the code is the same.

## Running

Inside this monorepo, the build resolves `io.tether:qvac-sdk-kotlin` to the SDK
source in the parent directory. From `packages/sdk-kotlin`:

```bash
./gradlew -p examples run -Pexample=Quickstart
./gradlew -p examples run -Pexample=Transcription --args="path/to/audio-16khz.wav"
```

Outside the monorepo, extract the release's `qvac-sdk-kotlin-jvm-<version>-maven.zip`
and set `qvacMavenRepository=/absolute/path/to/it` in `gradle.properties`; the
[Kotlin quickstart](https://docs.qvac.tether.io/sdk/kotlin-sdk#quickstart) walks
through it.

On first use, `connectResolved(installWorkerIfMissing = true)` installs the
pinned `@qvac/sdk` worker with npm. Models download over P2P from the registry
and are cached locally. Each file's header comment names its arguments and any
environment variable it reads.

Worker settings that the JS/TS examples read from a `qvac.config.*` file are
passed inline, as the `config` argument of `connectResolved`.

`RagMongodb` and `RagSqlite` write to third-party stores. The build adds their
database drivers to those two examples only. `Finetune` trains on
`train.jsonl` and `eval.jsonl` from this directory.

## Checks

```bash
./gradlew -p examples check
```

- `compileExamples` compiles every example in isolation against the SDK.
- `verifyEntryPoints` checks that every example compiles to a launchable
  `static void main(String[])`.

## Index

| Example | Mirrors |
| --- | --- |
| `AbotWorld.kt` | `packages/sdk/examples/abot-world.ts` |
| `AdvisoryModelFit.kt` | `packages/sdk/examples/advisory-model-fit.ts` |
| `AssessModelFit.kt` | `packages/sdk/examples/assess-model-fit.ts` |
| `AudiogenCover.kt` | `packages/sdk/examples/audiogen/generate-cover.ts` |
| `AudiogenEdit.kt` | `packages/sdk/examples/audiogen/edit-music.ts` |
| `Audiogen.kt` | `packages/sdk/examples/audiogen/generate-music.ts` |
| `AudiogenMinimax.kt` | `packages/sdk/examples/audiogen/generate-music-minimax.ts` |
| `AudiogenUnderstand.kt` | `packages/sdk/examples/audiogen/understand-music.ts` |
| `BatchCompletion.kt` | `packages/sdk/examples/batch-completion.ts` |
| `BciFilesystem.kt` | `packages/sdk/examples/bci/bci-filesystem.ts` |
| `BciFilesystemStreaming.kt` | `packages/sdk/examples/bci/bci-filesystem-streaming.ts` |
| `Cancel.kt` | `packages/sdk/examples/cancel-by-request-id.ts` |
| `ClassifyImage.kt` | `packages/sdk/examples/classification/classify-image.ts` |
| `CompletionDeferredTools.kt` | `packages/sdk/examples/tools/llamacpp-deferred-tools.ts` |
| `CompletionEvents.kt` | `packages/sdk/examples/completion-events.ts` |
| `CompletionOrchestrate.kt` | `packages/sdk-python/examples/completion_orchestrate.py` |
| `CompletionTools.kt` | `packages/sdk/examples/tools/llamacpp-native-tools.ts` |
| `Decisions.kt` | `packages/sdk/examples/decisions.ts` |
| `DiffusionEsrganUpscale.kt` | `packages/sdk/examples/diffusion-esrgan-upscale.ts` |
| `DiffusionFlux2KleinImg2img.kt` | `packages/sdk/examples/diffusion-flux2-klein-img2img.ts` |
| `DiffusionFlux2Klein.kt` | `packages/sdk/examples/diffusion-flux2-klein.ts` |
| `DiffusionIcLoraLtx.kt` | `packages/sdk/examples/diffusion-ic-lora-ltx.ts` |
| `DiffusionIdeogram.kt` | `packages/sdk/examples/diffusion-ideogram.ts` |
| `DiffusionImg2vid.kt` | `packages/sdk/examples/diffusion-img2vid.ts` |
| `DiffusionImg2vidLtx.kt` | `packages/sdk/examples/diffusion-img2vid-ltx.ts` |
| `DiffusionImg2vidMinimaxH3.kt` | `packages/sdk/examples/diffusion-img2vid-minimax-h3.ts` |
| `DiffusionQwenImage21.kt` | `packages/sdk/examples/diffusion-qwen-image-21.ts` |
| `DiffusionSimple.kt` | `packages/sdk/examples/diffusion-simple.ts` |
| `DiffusionTxt2vid.kt` | `packages/sdk/examples/diffusion-txt2vid.ts` |
| `DiffusionTxt2vidLtx.kt` | `packages/sdk/examples/diffusion-txt2vid-ltx.ts` |
| `DiffusionTxt2vidMinimaxH3.kt` | `packages/sdk/examples/diffusion-txt2vid-minimax-h3.ts` |
| `DiffusionTxt2vidWan22.kt` | `packages/sdk/examples/diffusion-txt2vid-wan22.ts` |
| `Embeddings.kt` | `packages/sdk/examples/embed-p2p.ts` |
| `Finetune.kt` | `packages/sdk/examples/finetune/llamacpp-finetune.ts` |
| `KvCache.kt` | `packages/sdk/examples/kv-cache-example.ts` |
| `LoggingGlobal.kt` | `packages/sdk/examples/logging-global.ts` |
| `LoggingStreams.kt` | `packages/sdk/examples/logging-streaming.ts` |
| `ModelInfo.kt` | `packages/sdk/examples/cache-management.ts` |
| `MultiJobCompletion.kt` | `packages/sdk/examples/multi-job-completion.ts` |
| `Multimodal.kt` | `packages/sdk/examples/llamacpp-multimodal.ts` |
| `Ocr.kt` | `packages/sdk/examples/ocr-fasttext.ts` |
| `Plugins.kt` | `packages/sdk/examples/plugins.ts` |
| `Quickstart.kt` | `packages/sdk/examples/quickstart.ts` |
| `RagManaged.kt` | `packages/sdk/examples/rag/rag-hyperdb/ingest.ts` |
| `RagMongodb.kt` | `packages/sdk/examples/rag/rag-mongodb.ts` |
| `RagSqlite.kt` | `packages/sdk/examples/rag/rag-sqlite.ts` |
| `RagTurbovec.kt` | `packages/sdk/examples/rag/rag-turbovec.ts` |
| `RegistryQuery.kt` | `packages/sdk/examples/registry-query.ts` |
| `Rerank.kt` | `packages/sdk/examples/rerank.ts` |
| `ShardedModels.kt` | `packages/sdk/examples/llamacpp-sharded.ts` |
| `SuspendResume.kt` | `packages/sdk/examples/suspend-resume.ts` |
| `TextToSpeechAudio8.kt` | `packages/sdk/examples/tts/audio8.ts` |
| `TextToSpeechChatterboxEnhanced.kt` | `packages/sdk/examples/tts/chatterbox-enhanced.ts` |
| `TextToSpeechChatterbox.kt` | `packages/sdk/examples/tts/chatterbox.ts` |
| `TextToSpeechCosyvoice3.kt` | `packages/sdk/examples/tts/cosyvoice3.ts` |
| `TextToSpeech.kt` | `packages/sdk/examples/tts/supertonic.ts` |
| `TextToSpeechMossDialogue.kt` | `packages/sdk/examples/tts/moss-dialogue.ts` |
| `TextToSpeechMoss.kt` | `packages/sdk/examples/tts/moss.ts` |
| `TextToSpeechMossSoundEffectControls.kt` | `packages/sdk/examples/tts/moss-sound-effect-controls.ts` |
| `TextToSpeechMossSoundEffect.kt` | `packages/sdk/examples/tts/moss-sound-effect.ts` |
| `TextToSpeechMossSpeechAudio.kt` | `packages/sdk/examples/tts/moss-speech-audio.ts` |
| `TextToSpeechMossSpeech.kt` | `packages/sdk/examples/tts/moss-speech.ts` |
| `TextToSpeechParler.kt` | `packages/sdk/examples/tts/parler.ts` |
| `TextToSpeechSupertonicEnhanced.kt` | `packages/sdk/examples/tts/supertonic-enhanced.ts` |
| `Transcription.kt` | `packages/sdk/examples/asr/whispercpp-filesystem.ts` |
| `TranscriptionParakeetCtc.kt` | `packages/sdk/examples/asr/parakeet-ctc-filesystem.ts` |
| `TranscriptionParakeetIndicConformer.kt` | `packages/sdk/examples/asr/parakeet-indic-conformer-filesystem.ts` |
| `TranscriptionParakeetSortformer.kt` | `packages/sdk/examples/asr/parakeet-sortformer.ts` |
| `TranscriptionParakeetTdt.kt` | `packages/sdk/examples/asr/parakeet-tdt-filesystem.ts` |
| `TranscriptionParakeetTranscribepsy.kt` | `packages/sdk/examples/asr/parakeet-transcribepsy-filesystem.ts` |
| `TranscriptionParakeetUnifiedCoreml.kt` | `packages/sdk/examples/asr/parakeet-unified-coreml.ts` |
| `TranscriptionParakeetUnified.kt` | `packages/sdk/examples/asr/parakeet-unified-filesystem.ts` |
| `Translation.kt` | `packages/sdk/examples/translation/translation-llm.ts` |
| `VlaGroot.kt` | `packages/sdk/examples/vla-groot.ts` |
| `Vla.kt` | `packages/sdk/examples/vla-smolvla.ts` |
| `VlaPi05.kt` | `packages/sdk/examples/vla-pi05.ts` |
| `VoiceAssistant.kt` | `packages/sdk/examples/voice-assistant/voice-assistant.ts` |
