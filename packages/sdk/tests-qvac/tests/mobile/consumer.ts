import { Platform } from "react-native";
import { createExecutor, SkipExecutor } from "@tetherto/qvac-test-suite/mobile";
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
  TTS_TOKENIZER_EN_CHATTERBOX,
  TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32,
  TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32,
  TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32,
  TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32,
  TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE,
  TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE,
  PARAKEET_TDT_ENCODER_INT8,
  PARAKEET_TDT_DECODER_INT8,
  PARAKEET_TDT_PREPROCESSOR_INT8,
  PARAKEET_TDT_VOCAB,
  PARAKEET_CTC_FP32,
  PARAKEET_CTC_TOKENIZER,
  PARAKEET_SORTFORMER_FP32,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  SALAMANDRATA_2B_INST_Q4,
  AFRICAN_4B_TRANSLATION_Q4_K_M,
  SD_V2_1_1B_Q8_0,
} from "@qvac/sdk";
import { ResourceManager } from "../shared/resource-manager.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { CompletionExecutor } from "../shared/executors/completion-executor.js";
import { EmbeddingExecutor } from "../shared/executors/embedding-executor.js";
import { ToolsExecutor } from "../shared/executors/tools-executor.js";
import { TranslationExecutor } from "../shared/executors/translation-executor.js";
import { ShardedModelExecutor } from "../shared/executors/sharded-model-executor.js";
import { HttpEmbeddingExecutor } from "../shared/executors/http-embedding-executor.js";
import { KvCacheExecutor } from "../shared/executors/kv-cache-executor.js";
import { LoggingExecutor } from "../shared/executors/logging-executor.js";
import { RegistryExecutor } from "../shared/executors/registry-executor.js";
import { ModelInfoExecutor } from "../shared/executors/model-info-executor.js";
import { ErrorExecutor } from "../shared/executors/error-executor.js";
import { MobileTranscriptionExecutor } from "./executors/transcription-executor.js";
import { MobileParakeetExecutor } from "./executors/parakeet-executor.js";
import { MobileVisionExecutor } from "./executors/vision-executor.js";
import { MobileOcrExecutor } from "./executors/ocr-executor.js";
import { MobileRagExecutor } from "./executors/rag-executor.js";
import { MobileConfigReloadExecutor } from "./executors/config-reload-executor.js";
import { MobileTtsExecutor } from "./executors/tts-executor.js";
import { DownloadExecutor } from "../shared/executors/download-executor.js";
import { DelegatedInferenceExecutor } from "../shared/executors/delegated-inference-executor.js";
import { DiffusionExecutor } from "../shared/executors/diffusion-executor.js";
import { LifecycleExecutor } from "../shared/executors/lifecycle-executor.js";

const resources = new ResourceManager();

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

resources.define("ocr", {
  constant: OCR_LATIN_RECOGNIZER_1,
  type: "ocr",
  config: { langList: ["en"] },
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
  constant: TTS_TOKENIZER_EN_CHATTERBOX,
  type: "tts",
  skipPreDownload: true,
  config: {
    ttsEngine: "chatterbox",
    language: "en",
    ttsTokenizerSrc: TTS_TOKENIZER_EN_CHATTERBOX,
    ttsSpeechEncoderSrc: TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32,
    ttsEmbedTokensSrc: TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32,
    ttsConditionalDecoderSrc: TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32,
    ttsLanguageModelSrc: TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32,
  },
});

const ttsSupertonicBaseConfig = {
  ttsEngine: "supertonic",
  ttsTextEncoderSrc: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
  ttsDurationPredictorSrc: TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32,
  ttsVectorEstimatorSrc: TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32,
  ttsVocoderSrc: TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32,
  ttsUnicodeIndexerSrc: TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32,
  ttsTtsConfigSrc: TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE,
  ttsVoiceStyleSrc: TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE,
};

resources.define("tts-supertonic", {
  constant: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
  type: "onnx-tts",
  skipPreDownload: true,
  config: {
    ...ttsSupertonicBaseConfig,
    language: "en",
  },
});

resources.define("tts-supertonic-multilingual", {
  constant: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
  type: "onnx-tts",
  skipPreDownload: true,
  config: {
    ...ttsSupertonicBaseConfig,
    language: "es",
    supertonicMultilingual: true,
  },
});

// Parakeet TDT 0.6B (INT8) — multilingual speech-to-text (~700MB)
resources.define("parakeet-tdt", {
  constant: PARAKEET_TDT_ENCODER_INT8,
  type: "parakeet",
  skipPreDownload: true,
  config: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_INT8,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_INT8,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_INT8,
  },
});

// Parakeet CTC FP32 — streaming-capable speech-to-text
resources.define("parakeet-ctc", {
  constant: PARAKEET_CTC_FP32,
  type: "parakeet",
  skipPreDownload: true,
  config: {
    modelType: "ctc",
    parakeetCtcModelSrc: PARAKEET_CTC_FP32,
    parakeetTokenizerSrc: PARAKEET_CTC_TOKENIZER,
  },
});

// Parakeet Sortformer — speaker diarization
resources.define("parakeet-sortformer", {
  constant: PARAKEET_SORTFORMER_FP32,
  type: "parakeet",
  skipPreDownload: true,
  config: {
    modelType: "sortformer",
    parakeetSortformerSrc: PARAKEET_SORTFORMER_FP32,
  },
});

resources.define("vision", {
  constant: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  type: "llm",
  skipPreDownload: true,
  config: {
    ctx_size: 1024,
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  },
});

resources.define("diffusion", {
  constant: SD_V2_1_1B_Q8_0,
  type: "diffusion",
  config: {
    device: "gpu",
    threads: 4,
    prediction: "v",
    vae_on_cpu: true,
  },
});

function skipTests(testIds: string[], reason: string) {
  return new SkipExecutor(new RegExp(`^(${testIds.join("|")})$`), reason);
}

export async function bootstrap() {
  await resources.downloadAllOnce(console.log);
};

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
    new SkipExecutor(/^tools-(?!simple-function$|no-function-match$)/, "Tools test disabled on mobile"),
    ...(Platform.OS === "ios" ? [
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
      ], "OCR disabled on iOS (ONNX/CoreML OOM)"),
    ] : []),

    // Real executors
    new ModelLoadingExecutor(resources),
    new CompletionExecutor(resources),
    new MobileTranscriptionExecutor(resources),
    new EmbeddingExecutor(resources),
    new MobileRagExecutor(resources),
    new ModelInfoExecutor(resources),
    new ErrorExecutor(resources),
    new ToolsExecutor(resources),
    new TranslationExecutor(resources),
    new ShardedModelExecutor(resources),
    new MobileOcrExecutor(resources),
    new MobileTtsExecutor(resources),
    new MobileConfigReloadExecutor(resources),
    new LoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
    new MobileParakeetExecutor(resources),
    new MobileVisionExecutor(resources),
    new DownloadExecutor(),
    new DelegatedInferenceExecutor(),
    new DiffusionExecutor(resources),
    new LifecycleExecutor(resources),
  ],
  profiling: {
    init: () => profiler.enable({ mode: "summary", includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON(),
  },
});
