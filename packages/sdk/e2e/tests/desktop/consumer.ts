import { createExecutor, SkipExecutor, type TestDefinition } from "@tetherto/qvac-test-suite";
import {
  profiler,
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  GTE_LARGE_335M_FP16_SHARD,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  QWEN3_1_7B_INST_Q4,
  OCR_LATIN_RECOGNIZER_1,
  BERGAMOT_EN_FR,
  BERGAMOT_EN_ES,
  BERGAMOT_ES_EN,
  BERGAMOT_EN_IT,
  MARIAN_EN_HI_INDIC_200M_Q4_0,
  MARIAN_HI_EN_INDIC_200M_Q4_0,
  TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  TTS_S3GEN_EN_CHATTERBOX,
  TTS_EN_SUPERTONIC_Q8_0,
  TTS_MULTILINGUAL_SUPERTONIC2_Q8_0,
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
  WAN2_1_T2V_1_3B_FP16,
  WAN2_1_I2V_14B_Q4_K_M,
  CLIP_VISION_H,
  UMT5_XXL_FP16,
  WAN_2_1_COMFYUI_REPACKAGED_VAE,
  SD_V2_1_1B_Q8_0,
  REALESRGAN_X4PLUS_ANIME_6B,
  QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  GEMMA4_2B_MULTIMODAL_Q4_K_M,
  BCI_WINDOWED,
} from "@qvac/sdk";
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
import { TranscriptionExecutor } from "./executors/transcription-executor.js";
import { TranscribeStreamEventsExecutor } from "./executors/transcribe-stream-events-executor.js";
import { RagExecutor } from "./executors/rag-executor.js";
import { OcrExecutor } from "./executors/ocr-executor.js";
import { VlaExecutor } from "../shared/executors/vla-executor.js";
import { ClassificationExecutor } from "./executors/classification-executor.js";
import { ConfigReloadExecutor } from "./executors/config-reload-executor.js";
import { DesktopLoggingExecutor } from "./executors/logging-executor.js";
import { RegistryExecutor } from "../shared/executors/registry-executor.js";
import { ModelInfoExecutor } from "../shared/executors/model-info-executor.js";
import { WrongModelExecutor } from "../shared/executors/wrong-model-executor.js";
import { ErrorExecutor } from "../shared/executors/error-executor.js";
import { TtsExecutor } from "../shared/executors/tts-executor.js";
import { ParakeetStreamExecutor } from "./executors/parakeet-stream-executor.js";
import { ParakeetExecutor } from "./executors/parakeet-executor.js";
import { BciExecutor } from "./executors/bci-executor.js";
import { VisionExecutor } from "./executors/vision-executor.js";
import { DownloadExecutor } from "../shared/executors/download-executor.js";
import { DelegatedInferenceExecutor } from "./executors/delegated-inference-executor.js";
import { DesktopDiffusionExecutor } from "./executors/diffusion-executor.js";
import { VideoExecutor } from "./executors/video-executor.js";
import { FinetuneExecutor } from "./executors/finetune-executor.js";
import { LifecycleExecutor } from "../shared/executors/lifecycle-executor.js";
import { ConfigExecutor } from "../shared/executors/config-executor.js";
import { NoLingeringBareExecutor } from "./executors/no-lingering-bare-executor.js";
import { MultiGpuExecutor } from "../shared/executors/multi-gpu-executor.js";
import { DesktopCancellationExecutor } from "./executors/cancellation-executor.js";

const resources = new ResourceManager();
const isMacosCi = process.platform === "darwin" && process.env["GITHUB_ACTIONS"] === "true";

resources.define("llm", {
  constant: LLAMA_3_2_1B_INST_Q4_0,
  type: "llm",
  config: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
});

resources.define("finetune-llm", {
  constant: QWEN3_1_7B_INST_Q4,
  type: "llm",
  config: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
});

resources.define("embeddings", {
  constant: GTE_LARGE_FP16,
  type: "embeddings",
});

resources.define("whisper", {
  constant: WHISPER_TINY,
  type: "whisper",
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
  type: "llm",
  config: { ctx_size: 4096, tools: true },
});

resources.define("tools-dynamic", {
  constant: QWEN3_1_7B_INST_Q4,
  type: "llm",
  config: { ctx_size: 4096, tools: true, toolsMode: "dynamic" },
});

resources.define("tools-qwen35", {
  constant: QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  type: "llm",
  config: { ctx_size: 4096, tools: true },
});

resources.define("tools-gemma4", {
  constant: GEMMA4_2B_MULTIMODAL_Q4_K_M,
  type: "llm",
  config: { ctx_size: 4096, tools: true },
});

resources.define("ocr", {
  constant: OCR_LATIN_RECOGNIZER_1,
  type: "ocr",
  config: { langList: ["en"] },
});

resources.define("vla", {
  constant: SMOLVLA_LIBERO_VISION_Q8,
  type: "vla",
  config: { backend: "cpu" },
});

resources.define("vla-pi05", {
  constant: PI05_BASE_Q_AGGRESSIVE,
  type: "vla",
  config: { backend: "cpu" },
});

// Classification ships bundled weights inside @qvac/classification-ggml,
// so no registry constant / pre-download is required.
resources.define("classification", {
  type: "classification",
});

resources.define("sharded-embeddings", {
  constant: GTE_LARGE_335M_FP16_SHARD,
  type: "embeddings",
  skipPreDownload: true,
});

resources.define("indictrans-en-hi", {
  constant: MARIAN_EN_HI_INDIC_200M_Q4_0,
  type: "nmt",
  config: {
    engine: "IndicTrans",
    from: "eng_Latn",
    to: "hin_Deva",
  },
});

resources.define("indictrans-hi-en", {
  constant: MARIAN_HI_EN_INDIC_200M_Q4_0,
  type: "nmt",
  config: {
    engine: "IndicTrans",
    from: "hin_Deva",
    to: "eng_Latn",
  },
});

resources.define("bergamot-en-fr", {
  constant: BERGAMOT_EN_FR,
  type: "nmt",
  config: {
    engine: "Bergamot",
    from: "en",
    to: "fr",
  },
});

resources.define("bergamot-en-es", {
  constant: BERGAMOT_EN_ES,
  type: "nmt",
  config: {
    engine: "Bergamot",
    from: "en",
    to: "es",
  },
});

resources.define("bergamot-es-it-pivot", {
  constant: BERGAMOT_ES_EN,
  type: "nmt",
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
  type: "llm",
});

resources.define("afriquegemma", {
  constant: AFRICAN_4B_TRANSLATION_Q4_K_M,
  type: "llm",
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
  constant: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  type: "tts",
  config: {
    ttsEngine: "chatterbox",
    language: "en",
    s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX,
    referenceAudioSrc: path.resolve(
      process.cwd(),
      "assets/audio",
      "transcription-short-wav.wav",
    ),
  },
});

resources.define("tts-supertonic", {
  constant: TTS_EN_SUPERTONIC_Q8_0,
  type: "tts",
  config: {
    ttsEngine: "supertonic",
    language: "en",
    voice: "F1",
  },
});

resources.define("tts-supertonic-multilingual", {
  constant: TTS_MULTILINGUAL_SUPERTONIC2_Q8_0,
  type: "tts",
  config: {
    ttsEngine: "supertonic",
    language: "es",
    voice: "F1",
  },
});

resources.define("parakeet-tdt", {
  constant: PARAKEET_TDT_0_6B_V3_Q8_0,
  type: "parakeet",
  config: {},
});

resources.define("parakeet-ctc", {
  constant: PARAKEET_CTC_0_6B_Q8_0,
  type: "parakeet",
  config: {},
});

resources.define("parakeet-sortformer", {
  constant: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
  type: "parakeet",
  config: {},
});

resources.define("parakeet-eou", {
  constant: PARAKEET_EOU_120M_V1_Q8_0,
  type: "parakeet",
  config: {},
});

resources.define("bci", {
  constant: BCI_WINDOWED,
  type: "bci",
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
  type: "llm",
  config: {
    ctx_size: 1024,
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  },
});

resources.define("diffusion", {
  constant: FLUX_2_KLEIN_4B_Q4_0,
  type: "diffusion",
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
  type: "diffusion",
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
  type: "diffusion",
  config: {
    device: "gpu",
    threads: 4,
    prediction: "flux2_flow",
    llmModelSrc: QWEN3_4B_Q4_K_M,
    vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
    diffusion_fa: false,
  },
});

resources.define("video", {
  constant: WAN2_1_T2V_1_3B_FP16,
  type: "diffusion",
  config: {
    mode: "video",
    device: "gpu",
    threads: 4,
    t5XxlModelSrc: UMT5_XXL_FP16,
    vaeModelSrc: WAN_2_1_COMFYUI_REPACKAGED_VAE,
    diffusion_fa: true,
    offload_to_cpu: true,
    vae_on_cpu: true,
    vae_tiling: true,
  },
});

resources.define("video-img2vid", {
  constant: WAN2_1_I2V_14B_Q4_K_M,
  type: "diffusion",
  config: {
    mode: "video",
    device: "gpu",
    threads: 4,
    t5XxlModelSrc: UMT5_XXL_FP16,
    vaeModelSrc: WAN_2_1_COMFYUI_REPACKAGED_VAE,
    clipVisionModelSrc: CLIP_VISION_H,
    diffusion_fa: true,
    offload_to_cpu: true,
    vae_on_cpu: true,
    vae_tiling: true,
  },
});

// Isolated from "diffusion" so ESRGAN load failures don't affect the rest of the suite.
resources.define("diffusion-esrgan", {
  constant: SD_V2_1_1B_Q8_0,
  type: "diffusion",
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
  type: "diffusion",
  config: {
    mode: "upscale",
    upscaler: {
      tile_size: 128,
    },
  },
});

resources.define("upscaler-cpu", {
  constant: REALESRGAN_X4PLUS_ANIME_6B,
  type: "diffusion",
  config: {
    mode: "upscale",
    device: "cpu",
    upscaler: {
      tile_size: 64,
    },
  },
});

// Exercises registryDownloadMaxRetries + registryStreamTimeoutMs end-to-end (see config-tests.ts).
function ensureDesktopE2EConfig() {
  if (!process.env["QVAC_CONFIG_PATH"]) {
    process.env["QVAC_CONFIG_PATH"] = path.resolve(
      process.cwd(),
      "fixtures/qvac.config.e2e.json",
    );
    console.log(`📦 Desktop e2e config set to ${process.env["QVAC_CONFIG_PATH"]}`);
  } else {
    console.log(`📦 Desktop e2e config: QVAC_CONFIG_PATH already set to ${process.env["QVAC_CONFIG_PATH"]}, skipping`);
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
    ...(isMacosCi ? [
      // QVAC-19555: passes locally on macOS in ~2m, but the current
      // mac-mini-m4-gpu CI runner crashes in ggml-metal and leaves later
      // tests timing out. Re-enable when a stronger macOS runner is available.
      new SkipExecutor(/^video-basic-(txt2vid|img2vid)$/, "Quarantined on macOS CI until a stronger runner replaces mac-mini-m4-gpu"),
    ] : []),

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
    new DesktopLoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
    new ParakeetStreamExecutor(resources),
    new ParakeetExecutor(resources),
    new BciExecutor(resources),
    new VisionExecutor(resources),
    new DownloadExecutor(),
    new DelegatedInferenceExecutor(),
    new DesktopDiffusionExecutor(resources),
    new VideoExecutor(resources),
    new FinetuneExecutor(resources),
    new LifecycleExecutor(resources),
    new ConfigExecutor(),
    new NoLingeringBareExecutor(),
    new MultiGpuExecutor(resources),
    new DesktopCancellationExecutor(resources),
  ],
  profiling: {
    init: () => profiler.enable({ mode: "summary", includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON(),
  },
});
