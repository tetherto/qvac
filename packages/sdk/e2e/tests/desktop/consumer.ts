import { createExecutor, type TestDefinition } from "@tetherto/qvac-test-suite";
import {
  profiler,
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  GTE_LARGE_335M_FP16_SHARD,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  QWEN3_1_7B_INST_Q4,
  OCR_CRAFT,
  OCR_LATIN,
  BERGAMOT_EN_FR,
  BERGAMOT_EN_ES,
  BERGAMOT_ES_EN,
  BERGAMOT_EN_IT,
  MARIAN_EN_HI_INDIC_200M_Q4_0,
  MARIAN_HI_EN_INDIC_200M_Q4_0,
  TTS_T3_TURBO_EN_CHATTERBOX_Q4_0,
  TTS_S3GEN_EN_CHATTERBOX_Q4_0,
  TTS_EN_SUPERTONIC_Q8_0,
  TTS_MULTILINGUAL_SUPERTONIC3_Q4_0,
  PARAKEET_TDT_0_6B_V3_Q8_0,
  PARAKEET_CTC_0_6B_Q8_0,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
  PARAKEET_EOU_120M_V1_Q8_0,
  SMOLVLA_LIBERO_VISION_Q8,
  PI05_BASE_Q_AGGRESSIVE,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  SALAMANDRATA_2B_INST_Q4,
  AFRICAN_4B_TRANSLATION_Q4_K_M,
  FLUX_2_KLEIN_4B_Q4_0,
  FLUX_2_KLEIN_4B_VAE,
  QWEN3_4B_Q4_K_M,
  SD_V2_1_1B_Q8_0,
  REALESRGAN_X4PLUS_ANIME_6B,
  QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  GEMMA4_2B_MULTIMODAL_Q4_K_M,
  BCI_WINDOWED,
} from "@qvac/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { ResourceManager } from "../shared/resource-manager.js";
import { collectTestDeps } from "../shared/collect-test-deps.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { CompletionExecutor } from "../shared/executors/completion-executor.js";
import { ToolsExecutor } from "../shared/executors/tools-executor.js";
import { TranslationExecutor } from "../shared/executors/translation-executor.js";
import { TranslationBergamotCacheExecutor } from "../shared/executors/translation-bergamot-cache-executor.js";
import { ShardedModelExecutor } from "../shared/executors/sharded-model-executor.js";
import { HttpEmbeddingExecutor } from "../shared/executors/http-embedding-executor.js";
import { KvCacheExecutor } from "../shared/executors/kv-cache-executor.js";
import { EmbeddingExecutor } from "../shared/executors/embedding-executor.js";
import { TranscriptionExecutor } from "../shared/executors/node/transcription-executor.js";
import { TranscribeStreamEventsExecutor } from "../shared/executors/node/transcribe-stream-events-executor.js";
import { RagExecutor } from "../shared/executors/node/rag-executor.js";
import { OcrExecutor } from "../shared/executors/node/ocr-executor.js";
import { VlaExecutor } from "../shared/executors/vla-executor.js";
import { ClassificationExecutor } from "../shared/executors/node/classification-executor.js";
import { ConfigReloadExecutor } from "../shared/executors/node/config-reload-executor.js";
import { NodeLoggingExecutor } from "../shared/executors/node/logging-executor.js";
import { RegistryExecutor } from "../shared/executors/registry-executor.js";
import { ModelInfoExecutor } from "../shared/executors/model-info-executor.js";
import { WrongModelExecutor } from "../shared/executors/wrong-model-executor.js";
import { ErrorExecutor } from "../shared/executors/error-executor.js";
import { TtsExecutor } from "../shared/executors/tts-executor.js";
import { ParakeetStreamExecutor } from "../shared/executors/node/parakeet-stream-executor.js";
import { ParakeetExecutor } from "../shared/executors/node/parakeet-executor.js";
import { BciExecutor } from "../shared/executors/node/bci-executor.js";
import { VisionExecutor } from "../shared/executors/node/vision-executor.js";
import { DownloadExecutor } from "../shared/executors/download-executor.js";
import { DelegatedInferenceExecutor } from "../shared/executors/node/delegated-inference-executor.js";
import { NodeDiffusionExecutor } from "../shared/executors/node/diffusion-executor.js";
import { FinetuneExecutor } from "../shared/executors/node/finetune-executor.js";
import { LifecycleExecutor } from "../shared/executors/lifecycle-executor.js";
import { ConfigExecutor } from "../shared/executors/config-executor.js";
import { NoLingeringBareExecutor } from "../shared/executors/node/no-lingering-bare-executor.js";
import { MultiGpuExecutor } from "../shared/executors/multi-gpu-executor.js";
import { NodeCancellationExecutor } from "../shared/executors/node/cancellation-executor.js";

const resources = new ResourceManager({
  downloadTarget: "desktop",
});

resources.define("llm", {
  constant: LLAMA_3_2_1B_INST_Q4_0,
  type: "llamacpp-completion",
  config: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
});

resources.define("finetune-llm", {
  constant: QWEN3_1_7B_INST_Q4,
  type: "llamacpp-completion",
  config: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
});

resources.define("embeddings", {
  constant: GTE_LARGE_FP16,
  type: "llamacpp-embedding",
});

resources.define("whisper", {
  constant: WHISPER_TINY,
  type: "whispercpp-transcription",
  config: {
    vadModelSrc: VAD_SILERO_5_1_2,
    audio_format: "f32le",
    strategy: "greedy",
    language: "en",
    translate: false,
    no_timestamps: false,
    single_segment: false,
    temperature: 0.0,
    suppress_blank: true,
    suppress_nst: true,
    vad_params: {
      threshold: 0.35,
      min_speech_duration_ms: 200,
      min_silence_duration_ms: 150,
      max_speech_duration_s: 30.0,
      speech_pad_ms: 600,
      samples_overlap: 0.3,
    },
  },
});

resources.define("tools", {
  constant: QWEN3_1_7B_INST_Q4,
  type: "llamacpp-completion",
  config: { ctx_size: 4096, tools: true },
});

resources.define("tools-dynamic", {
  constant: QWEN3_1_7B_INST_Q4,
  type: "llamacpp-completion",
  config: { ctx_size: 4096, tools: true, toolsMode: "dynamic" },
});

resources.define("tools-qwen35", {
  constant: QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  type: "llamacpp-completion",
  config: { ctx_size: 4096, tools: true },
});

resources.define("tools-gemma4", {
  constant: GEMMA4_2B_MULTIMODAL_Q4_K_M,
  type: "llamacpp-completion",
  config: { ctx_size: 4096, tools: true },
});

resources.define("ocr", {
  constant: OCR_LATIN,
  type: "ggml-ocr",
  // Pre-cache the CRAFT detector too (it's otherwise derived at loadModel time
  // and downloaded on-device, making the first OCR test cold-start time out on
  // mobile). Mirrors the whisper VAD companion-download pattern.
  config: { langList: ["en"], detectorModelSrc: OCR_CRAFT },
});

resources.define("vla", {
  constant: SMOLVLA_LIBERO_VISION_Q8,
  type: "ggml-vla",
  config: { backend: "cpu" },
});

resources.define("vla-pi05", {
  constant: PI05_BASE_Q_AGGRESSIVE,
  type: "ggml-vla",
  config: { backend: "cpu" },
});

// Classification ships bundled weights inside @qvac/classification-ggml,
// so no registry constant / pre-download is required.
resources.define("classification", {
  type: "ggml-classification",
});

resources.define("sharded-embeddings", {
  constant: GTE_LARGE_335M_FP16_SHARD,
  type: "llamacpp-embedding",
  skipPreDownload: true,
});

resources.define("indictrans-en-hi", {
  constant: MARIAN_EN_HI_INDIC_200M_Q4_0,
  type: "nmtcpp-translation",
  config: {
    engine: "IndicTrans",
    from: "eng_Latn",
    to: "hin_Deva",
  },
});

resources.define("indictrans-hi-en", {
  constant: MARIAN_HI_EN_INDIC_200M_Q4_0,
  type: "nmtcpp-translation",
  config: {
    engine: "IndicTrans",
    from: "hin_Deva",
    to: "eng_Latn",
  },
});

resources.define("bergamot-en-fr", {
  constant: BERGAMOT_EN_FR,
  type: "nmtcpp-translation",
  config: {
    engine: "Bergamot",
    from: "en",
    to: "fr",
  },
});

resources.define("bergamot-en-es", {
  constant: BERGAMOT_EN_ES,
  type: "nmtcpp-translation",
  config: {
    engine: "Bergamot",
    from: "en",
    to: "es",
  },
});

resources.define("bergamot-es-it-pivot", {
  constant: BERGAMOT_ES_EN,
  type: "nmtcpp-translation",
  config: {
    engine: "Bergamot",
    from: "es",
    to: "it",
    pivotModel: {
      modelSrc: BERGAMOT_EN_IT,
      beamsize: 4,
      temperature: 0.3,
    },
  },
});

resources.define("salamandra", {
  constant: SALAMANDRATA_2B_INST_Q4,
  type: "llamacpp-completion",
});

resources.define("afriquegemma", {
  constant: AFRICAN_4B_TRANSLATION_Q4_K_M,
  type: "llamacpp-completion",
  config: {
    tools: true,
    ctx_size: 2048,
    top_k: 1,
    top_p: 1,
    temp: 0,
    repeat_penalty: 1,
    seed: 42,
    predict: 256,
    stop_sequences: ["\n"],
  },
});


resources.define("tts-chatterbox", {
  constant: TTS_T3_TURBO_EN_CHATTERBOX_Q4_0,
  type: "tts-ggml",
  config: {
    ttsEngine: "chatterbox",
    language: "en",
    useGPU: true,
    s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX_Q4_0,
    streamChunkTokens: 25,
    streamFirstChunkTokens: 10,
    cfmSteps: 1,
    referenceAudioSrc: path.resolve(
      process.cwd(),
      "assets/audio",
      "transcription-short-wav.wav",
    ),
  },
});

resources.define("tts-supertonic", {
  constant: TTS_EN_SUPERTONIC_Q8_0,
  type: "tts-ggml",
  config: {
    ttsEngine: "supertonic",
    language: "en",
    voice: "F1",
    useGPU: true,
  },
});

resources.define("tts-supertonic-multilingual", {
  constant: TTS_MULTILINGUAL_SUPERTONIC3_Q4_0,
  type: "tts-ggml",
  config: {
    ttsEngine: "supertonic",
    language: "es",
    voice: "F1",
    useGPU: true,
  },
});

resources.define("parakeet-tdt", {
  constant: PARAKEET_TDT_0_6B_V3_Q8_0,
  type: "parakeet-transcription",
  config: {},
});

resources.define("parakeet-ctc", {
  constant: PARAKEET_CTC_0_6B_Q8_0,
  type: "parakeet-transcription",
  config: {},
});

resources.define("parakeet-sortformer", {
  constant: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
  type: "parakeet-transcription",
  config: {},
});

resources.define("parakeet-eou", {
  constant: PARAKEET_EOU_120M_V1_Q8_0,
  type: "parakeet-transcription",
  config: {},
});

resources.define("bci", {
  constant: BCI_WINDOWED,
  type: "bci-whispercpp-transcription",
  config: {
    whisperConfig: { language: "en", temperature: 0.0 },
    miscConfig: { caption_enabled: false },
    // Sample 2 (neural-not-too-controversial.bin) was recorded on session
    // day 1; day_idx selects the matching day-specific projection matrices.
    bciConfig: { day_idx: 1 },
  },
});

resources.define("vision", {
  constant: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  type: "llamacpp-completion",
  config: {
    ctx_size: 1024,
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  },
});

resources.define("diffusion", {
  constant: FLUX_2_KLEIN_4B_Q4_0,
  type: "sdcpp-generation",
  config: {
    device: "gpu",
    threads: 4,
    prediction: "flux2_flow",
    llmModelSrc: QWEN3_4B_Q4_K_M,
    vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
  },
});

resources.define("diffusion-fa", {
  constant: FLUX_2_KLEIN_4B_Q4_0,
  type: "sdcpp-generation",
  config: {
    device: "gpu",
    threads: 4,
    prediction: "flux2_flow",
    llmModelSrc: QWEN3_4B_Q4_K_M,
    vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
    diffusion_fa: true,
  },
});

resources.define("diffusion-fa-disabled", {
  constant: FLUX_2_KLEIN_4B_Q4_0,
  type: "sdcpp-generation",
  config: {
    device: "gpu",
    threads: 4,
    prediction: "flux2_flow",
    llmModelSrc: QWEN3_4B_Q4_K_M,
    vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
    diffusion_fa: false,
  },
});

// Isolated from "diffusion" so ESRGAN load failures don't affect the rest of the suite.
resources.define("diffusion-esrgan", {
  constant: SD_V2_1_1B_Q8_0,
  type: "sdcpp-generation",
  config: {
    device: "gpu",
    threads: 4,
    prediction: "v",
    vae_on_cpu: true,
    upscaler: {
      type: "esrgan",
      model_src: REALESRGAN_X4PLUS_ANIME_6B,
      tile_size: 128,
    },
  },
});

resources.define("upscaler", {
  constant: REALESRGAN_X4PLUS_ANIME_6B,
  type: "sdcpp-generation",
  config: {
    mode: "upscale",
    upscaler: {
      tile_size: 128,
    },
  },
});

resources.define("upscaler-cpu", {
  constant: REALESRGAN_X4PLUS_ANIME_6B,
  type: "sdcpp-generation",
  config: {
    mode: "upscale",
    device: "cpu",
    upscaler: {
      tile_size: 64,
    },
  },
});

function readJsonConfig(configPath: string) {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

// Exercises registryDownloadMaxRetries + registryStreamTimeoutMs end-to-end (see config-tests.ts).
function ensureDesktopE2EConfig() {
  const fixturePath = path.resolve(process.cwd(), "fixtures/qvac.config.e2e.json");
  const existingPath = process.env["QVAC_CONFIG_PATH"];
  const fixtureConfig = readJsonConfig(fixturePath);
  const existingConfig = existingPath ? readJsonConfig(existingPath) : {};
  const mergedConfig = {
    ...fixtureConfig,
    ...existingConfig,
  };
  const generatedPath = path.resolve(process.cwd(), "qvac.config.e2e.generated.json");

  fs.writeFileSync(generatedPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
  process.env["QVAC_CONFIG_PATH"] = generatedPath;

  if (existingPath) {
    console.log(
      `📦 Desktop e2e config merged ${fixturePath} with ${existingPath}; using ${generatedPath}`,
    );
  } else {
    console.log(`📦 Desktop e2e config set to ${generatedPath}`);
  }
}

export async function bootstrap(filteredTests?: TestDefinition[]) {
  ensureDesktopE2EConfig();

  // `filteredTests` (when present) is the producer's post-filter test list
  // delivered via register-ack; absence keeps the legacy "warm everything" path.
  const allowedDeps = filteredTests ? collectTestDeps(filteredTests) : undefined;
  await resources.downloadAllOnce(console.log, { allowedDeps });
}

export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(resources),
    new CompletionExecutor(resources),
    new TranscriptionExecutor(resources),
    new TranscribeStreamEventsExecutor(resources),
    new EmbeddingExecutor(resources),
    new RagExecutor(resources),
    new ModelInfoExecutor(resources),
    new WrongModelExecutor(resources),
    new ErrorExecutor(resources),
    new ToolsExecutor(resources),

    // Must precede TranslationExecutor — patterns overlap, dispatch is first-match-wins.
    new TranslationBergamotCacheExecutor(),
    new TranslationExecutor(resources),
    new ShardedModelExecutor(resources),
    new OcrExecutor(resources),
    new VlaExecutor(resources),
    new ClassificationExecutor(resources),
    new TtsExecutor(resources),
    new ConfigReloadExecutor(resources),
    new NodeLoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
    new ParakeetStreamExecutor(resources),
    new ParakeetExecutor(resources),
    new BciExecutor(resources),
    new VisionExecutor(resources),
    new DownloadExecutor(),
    new DelegatedInferenceExecutor(),
    new NodeDiffusionExecutor(resources),
    new FinetuneExecutor(resources),
    new LifecycleExecutor(resources),
    new ConfigExecutor(),
    new NoLingeringBareExecutor(),
    new MultiGpuExecutor(resources),
    new NodeCancellationExecutor(resources),
  ],
  profiling: {
    init: () => profiler.enable({ mode: "summary", includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON(),
  },
});
