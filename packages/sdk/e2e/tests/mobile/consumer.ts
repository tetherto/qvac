import { Platform } from "react-native";
import { createExecutor, SkipExecutor } from "@tetherto/qvac-test-suite/mobile";
import type { TestDefinition } from "@tetherto/qvac-test-suite";
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
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  SALAMANDRATA_2B_INST_Q4,
  AFRICAN_4B_TRANSLATION_Q4_K_M,
  SMOLVLA_LIBERO_VISION_Q8,
} from "@qvac/sdk";
import { ResourceManager } from "../shared/resource-manager.js";
import { collectTestDeps } from "../shared/collect-test-deps.js";
import { resolveBundledAssetUri } from "./asset-uri.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { CompletionExecutor } from "../shared/executors/completion-executor.js";
import { EmbeddingExecutor } from "../shared/executors/embedding-executor.js";
import { ToolsExecutor } from "../shared/executors/tools-executor.js";
import { TranslationExecutor } from "../shared/executors/translation-executor.js";
import { ShardedModelExecutor } from "../shared/executors/sharded-model-executor.js";
import { HttpEmbeddingExecutor } from "../shared/executors/http-embedding-executor.js";
import { KvCacheExecutor } from "../shared/executors/kv-cache-executor.js";
import { MobileLoggingExecutor } from "./executors/logging-executor.js";
import { RegistryExecutor } from "../shared/executors/registry-executor.js";
import { ModelInfoExecutor } from "../shared/executors/model-info-executor.js";
import { WrongModelExecutor } from "../shared/executors/wrong-model-executor.js";
import { ErrorExecutor } from "../shared/executors/error-executor.js";
import { MobileTranscriptionExecutor } from "./executors/transcription-executor.js";
import { MobileTranscribeStreamEventsExecutor } from "./executors/transcribe-stream-events-executor.js";
import { MobileParakeetStreamExecutor } from "./executors/parakeet-stream-executor.js";
import { MobileParakeetExecutor } from "./executors/parakeet-executor.js";
import { MobileVisionExecutor } from "./executors/vision-executor.js";
import { MobileOcrExecutor } from "./executors/ocr-executor.js";
import { VlaExecutor } from "../shared/executors/vla-executor.js";
import { MobileClassificationExecutor } from "./executors/classification-executor.js";
import { MobileRagExecutor } from "./executors/rag-executor.js";
import { MobileConfigReloadExecutor } from "./executors/config-reload-executor.js";
import { MobileTtsExecutor } from "./executors/tts-executor.js";
import { DownloadExecutor } from "../shared/executors/download-executor.js";
import { DelegatedInferenceExecutor } from "../shared/executors/delegated-inference-executor.js";
import { LifecycleExecutor } from "../shared/executors/lifecycle-executor.js";
import { ConfigExecutor } from "../shared/executors/config-executor.js";
import { MobileCancellationExecutor } from "./executors/cancellation-executor.js";

const resources = new ResourceManager({
  downloadTarget: "mobile",
  // Mobile (iOS + Android) needs a tick after each unloadModel for the
  // kernel to actually release pages / reclaim mmap regions — without
  // it, the next test's load arrives while the previous model's RSS is
  // still resident and either the GGML allocator crashes (iOS) or
  // Scudo's mmap fails with "internal map failure" (Android). Empirically
  // 200ms is enough; desktop doesn't need it.
  unloadSettleMs: 200,
});

resources.define("llm", {
  constant: LLAMA_3_2_1B_INST_Q4_0,
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

resources.define("ocr", {
  constant: OCR_LATIN_RECOGNIZER_1,
  type: "ocr",
  config: { langList: ["en"] },
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

/** Look up a bundled audio file by name and resolve it to a POSIX path. */
async function resolveBundledAudioUri(filename: string): Promise<string | undefined> {
  // @ts-ignore - assets.ts generated at consumer build time (consumer root, 3 levels up from dist/tests/mobile/)
  const assets = await import("../../../assets");
  const assetModule = assets.audio?.[filename];
  if (!assetModule) {
    console.warn(`[tts-chatterbox] reference audio not in registry: ${filename}`);
    return undefined;
  }
  try {
    return await resolveBundledAssetUri(assetModule);
  } catch (err) {
    console.warn(`[tts-chatterbox] failed to resolve ${filename}:`, err);
    return undefined;
  }
}

resources.define("tts-chatterbox", {
  constant: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  type: "tts",
  config: async () => ({
    ttsEngine: "chatterbox",
    language: "en",
    useGPU: true,
    s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX,
    referenceAudioSrc: await resolveBundledAudioUri("transcription-short-wav.wav"),
  }),
});

resources.define("tts-supertonic", {
  constant: TTS_EN_SUPERTONIC_Q8_0,
  type: "tts",
  config: {
    ttsEngine: "supertonic",
    language: "en",
    voice: "F1",
    useGPU: true,
  },
});

resources.define("tts-supertonic-multilingual", {
  constant: TTS_MULTILINGUAL_SUPERTONIC2_Q8_0,
  type: "tts",
  config: {
    ttsEngine: "supertonic",
    language: "es",
    voice: "F1",
    useGPU: true,
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

resources.define("vision", {
  constant: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  type: "llm",
  config: {
    ctx_size: 1024,
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  },
});

resources.define("vla", {
  constant: SMOLVLA_LIBERO_VISION_Q8,
  type: "vla",
  config: { backend: "cpu" },
});
// NOTE: no "vla-pi05" resource on mobile by design — the pi05 q_aggressive
// GGUF is 3.9 GB, which exceeds the iOS jetsam per-process limit (~3 GB →
// OOM kill) and is deferred on Android Device Farm until a CDN-fronted
// mirror exists. The pi05 e2e tests are skipped on mobile (see below);
// defining the resource here would make `downloadAllOnce` pre-fetch the
// 3.9 GB model even though the tests never run. Desktop covers pi05.

function skipTests(testIds: string[], reason: string) {
  return new SkipExecutor(new RegExp(`^(${testIds.join("|")})$`), reason);
}

async function ensureMobileE2EConfig() {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (env?.["QVAC_CONFIG_PATH"]) {
    console.log(`📦 Mobile e2e config: QVAC_CONFIG_PATH already set to ${env["QVAC_CONFIG_PATH"]}, skipping write`);
    return;
  }

  // @ts-ignore - assets.ts generated at consumer build time (consumer root, 3 levels up from dist/tests/mobile/)
  const assets = await import("../../../assets");
  const qvacE2EConfig = assets.other?.["qvac.config.e2e.json"];
  if (!qvacE2EConfig || typeof qvacE2EConfig !== "object") {
    throw new Error(
      "qvac.config.e2e.json fixture not found in mobile assets — ensure ./fixtures/**/* is listed in qvac-test.config.js mobile.assets.patterns",
    );
  }

  // @ts-ignore - expo-file-system is a peer dependency available in mobile context
  const { File, Paths } = await import("expo-file-system");
  const configFile = new File(Paths.document, "qvac.config.json");
  if (!configFile.exists) {
    configFile.create();
  }
  await configFile.write(`${JSON.stringify(qvacE2EConfig, null, 2)}\n`);
  const cfg = qvacE2EConfig as Record<string, unknown>;
  console.log(
    `📦 Mobile e2e config written to ${configFile.uri} ` +
    `(registryStreamTimeoutMs=${cfg["registryStreamTimeoutMs"]}, registryDownloadMaxRetries=${cfg["registryDownloadMaxRetries"]})`,
  );
}

export async function bootstrap(filteredTests?: TestDefinition[]) {
  await ensureMobileE2EConfig();

  // `filteredTests` (when present) is the producer's post-filter test list
  // delivered via register-ack; absence keeps the legacy "warm everything" path.
  const allowedDeps = filteredTests ? collectTestDeps(filteredTests) : undefined;
  await resources.downloadAllOnce(console.log, { allowedDeps });
}

export const executor = createExecutor({
  handlers: [
    // Mobile platform skips (before real executors -- first match wins)
    skipTests([
      "http-sharded-embed-load",
      "http-sharded-embed-progress",
      "http-archive-embed-load",
      "http-archive-embed-progress",
      "http-archive-embed-inference",
    ], "HTTP test disabled on mobile (OOM)"),
    new SkipExecutor(/^finetune-/, "Finetune tests disabled on mobile"),
    new SkipExecutor(/^multi-gpu-/, "Multi-GPU tests disabled on mobile (not supported on single-GPU devices)"),
    new SkipExecutor(/^tools-(?!simple-function$|no-function-match$)/, "Tools test disabled on mobile"),
    new SkipExecutor(/^(diffusion-|addon-logging-diffusion$)/, "SD v2.1 1B Q8_0 cold-load is too heavy for Device Farm devices (OOM, 3+GB)"),
    new SkipExecutor(/^vla-pi05-/, "π₀.₅ q_aggressive GGUF (3.9 GB) exceeds the iOS jetsam ~3 GB per-process limit (OOM) and is deferred on Android Device Farm until a CDN-fronted mirror exists; SmolVLA covers mobile VLA, desktop covers pi05"),
    new SkipExecutor(
      /^translation-bergamot-.+-cache-reload$/,
      "Server-side Bare code path, identical across platforms — desktop coverage is source of truth",
    ),
    new SkipExecutor(/^bci-/, "BCI addon tests are desktop-only until mobile support is enabled"),
    // suspend() hangs the test runner on mobile (the lifecycle coordinator
    // pauses MQTT/network ops and never resumes within the test timeout).
    // Only resume-idempotent is safe -- it does not call suspend().
    skipTests([
      "lifecycle-suspend-resume-basic",
      "lifecycle-suspend-idempotent",
      "lifecycle-suspend-resume-inference",
      "lifecycle-rapid-toggle",
      "lifecycle-suspend-during-inference",
    ], "suspend() hangs the runner on mobile"),
    ...(Platform.OS === "android" ? [
      skipTests([
        "parakeet-stream-eou",
        "parakeet-stream-iterator-throw",
      ], "Parakeet streaming EOU/iterator recovery is flaky on Android"),
    ] : []),
    ...(Platform.OS === "ios" ? [
      // QVAC-19557: Chatterbox TTS variants OOM on iOS Device Farm under the current memory budget.
      new SkipExecutor(/^tts-chatterbox-/, "Chatterbox TTS is flaky on iOS under Device Farm memory pressure (OOM)"),
      skipTests([
        "ocr-sign-image",
        "ocr-chart-image",
        "ocr-no-text-image",
        "ocr-large-image",
        "ocr-low-quality",
        "ocr-mixed-language",
        "ocr-single-language",
        "ocr-blurry-text",
        "ocr-horizontally-inverted",
        "ocr-vertically-inverted",
        "ocr-misaligned-text",
        "ocr-multi-sized-text",
        "ocr-multiple-fonts",
        "addon-logging-ocr",
      ], "OCR disabled on iOS (ONNX/CoreML OOM)"),
      new SkipExecutor(/^translation-afriquegemma-/, "AfriqueGemma 4B (~2.7 GB) exceeds iOS memory budget"),
    ] : []),

    // Real executors
    new ModelLoadingExecutor(resources),
    new CompletionExecutor(resources),
    new MobileTranscriptionExecutor(resources),
    new MobileTranscribeStreamEventsExecutor(resources),
    new EmbeddingExecutor(resources),
    new MobileRagExecutor(resources),
    new ModelInfoExecutor(resources),
    new WrongModelExecutor(resources),
    new ErrorExecutor(resources),
    new ToolsExecutor(resources),
    new TranslationExecutor(resources),
    new ShardedModelExecutor(resources),
    new MobileOcrExecutor(resources),
    new VlaExecutor(resources),
    new MobileClassificationExecutor(resources),
    new MobileTtsExecutor(resources),
    new MobileConfigReloadExecutor(resources),
    new MobileLoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
    new MobileParakeetStreamExecutor(resources),
    new MobileParakeetExecutor(resources),
    new MobileVisionExecutor(resources),
    new DownloadExecutor(),
    new DelegatedInferenceExecutor(),
    new LifecycleExecutor(resources),
    new ConfigExecutor(),
    new MobileCancellationExecutor(resources),
  ],
  profiling: {
    init: () => profiler.enable({ mode: "summary", includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON(),
  },
});
