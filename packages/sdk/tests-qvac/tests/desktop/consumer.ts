import { createExecutor } from "@tetherto/qvac-test-suite";
import {
  profiler,
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  GTE_LARGE_335M_FP16_SHARD,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  QWEN3_1_7B_INST_Q4,
  OCR_LATIN_RECOGNIZER_1,
  MARIAN_OPUS_DE_EN_Q4_0,
  MARIAN_OPUS_EN_ES_Q4_0,
  MARIAN_OPUS_ES_EN_Q4_0,
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
  TTS_TOKENIZER_SUPERTONIC,
  TTS_TEXT_ENCODER_SUPERTONIC_FP32,
  TTS_LATENT_DENOISER_SUPERTONIC_FP32,
  TTS_VOICE_DECODER_SUPERTONIC_FP32,
  TTS_VOICE_STYLE_SUPERTONIC,
  PARAKEET_TDT_ENCODER_INT8,
  PARAKEET_TDT_DECODER_INT8,
  PARAKEET_TDT_PREPROCESSOR_INT8,
  PARAKEET_TDT_VOCAB,
  PARAKEET_CTC_FP32,
  PARAKEET_CTC_DATA_FP32,
  PARAKEET_CTC_TOKENIZER,
  PARAKEET_SORTFORMER_FP32,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  SALAMANDRATA_2B_INST_Q4,
  AFRICAN_4B_TRANSLATION_Q4_K_M,
} from "@qvac/sdk";
import * as path from "node:path";
import { ResourceManager } from "../shared/resource-manager.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { CompletionExecutor } from "../shared/executors/completion-executor.js";
import { ToolsExecutor } from "../shared/executors/tools-executor.js";
import { TranslationExecutor } from "../shared/executors/translation-executor.js";
import { ShardedModelExecutor } from "../shared/executors/sharded-model-executor.js";
import { HttpEmbeddingExecutor } from "../shared/executors/http-embedding-executor.js";
import { KvCacheExecutor } from "../shared/executors/kv-cache-executor.js";
import { EmbeddingExecutor } from "../shared/executors/embedding-executor.js";
import { TranscriptionExecutor } from "./executors/transcription-executor.js";
import { RagExecutor } from "./executors/rag-executor.js";
import { OcrExecutor } from "./executors/ocr-executor.js";
import { ConfigReloadExecutor } from "./executors/config-reload-executor.js";
import { LoggingExecutor } from "../shared/executors/logging-executor.js";
import { RegistryExecutor } from "../shared/executors/registry-executor.js";
import { ModelInfoExecutor } from "../shared/executors/model-info-executor.js";
import { ErrorExecutor } from "../shared/executors/error-executor.js";
import { TtsExecutor } from "../shared/executors/tts-executor.js";
import { ParakeetExecutor } from "./executors/parakeet-executor.js";
import { VisionExecutor } from "./executors/vision-executor.js";
import { DownloadExecutor } from "../shared/executors/download-executor.js";

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

resources.define("marian-de-en", {
  constant: MARIAN_OPUS_DE_EN_Q4_0,
  type: "nmt",
  config: {
    engine: "Opus",
    from: "de",
    to: "en",
    beamsize: 4,
    lengthpenalty: 1.0,
    maxlength: 512,
    temperature: 0.3,
    norepeatngramsize: 3,
  },
});

resources.define("marian-en-es", {
  constant: MARIAN_OPUS_EN_ES_Q4_0,
  type: "nmt",
  config: {
    engine: "Opus",
    from: "en",
    to: "es",
    beamsize: 4,
    lengthpenalty: 1.0,
    maxlength: 512,
    temperature: 0.3,
    norepeatngramsize: 3,
  },
});

resources.define("marian-es-en", {
  constant: MARIAN_OPUS_ES_EN_Q4_0,
  type: "nmt",
  config: {
    engine: "Opus",
    from: "es",
    to: "en",
    beamsize: 4,
    lengthpenalty: 1.0,
    maxlength: 512,
    temperature: 0.3,
    norepeatngramsize: 3,
  },
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


const referenceAudioPath = path.resolve(process.cwd(), "assets/audio/transcription-short-wav.wav");

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
    referenceAudioSrc: referenceAudioPath,
  },
});

resources.define("tts-supertonic", {
  constant: TTS_TOKENIZER_SUPERTONIC,
  type: "tts",
  skipPreDownload: true,
  config: {
    ttsEngine: "supertonic",
    language: "en",
    ttsTokenizerSrc: TTS_TOKENIZER_SUPERTONIC,
    ttsTextEncoderSrc: TTS_TEXT_ENCODER_SUPERTONIC_FP32,
    ttsLatentDenoiserSrc: TTS_LATENT_DENOISER_SUPERTONIC_FP32,
    ttsVoiceDecoderSrc: TTS_VOICE_DECODER_SUPERTONIC_FP32,
    ttsVoiceSrc: TTS_VOICE_STYLE_SUPERTONIC,
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
    parakeetCtcModelDataSrc: PARAKEET_CTC_DATA_FP32,
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

await resources.downloadAllOnce(console.log);

export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(resources),
    new CompletionExecutor(resources),
    new TranscriptionExecutor(resources),
    new EmbeddingExecutor(resources),
    new RagExecutor(resources),
    new ModelInfoExecutor(resources),
    new ErrorExecutor(resources),
    new ToolsExecutor(resources),

    new TranslationExecutor(resources),
    new ShardedModelExecutor(resources),
    new OcrExecutor(resources),
    new TtsExecutor(resources),
    new ConfigReloadExecutor(resources),
    new LoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
    new ParakeetExecutor(resources),
    new VisionExecutor(resources),
    new DownloadExecutor(),
  ],
  profiling: {
    init: () => profiler.enable({ mode: "summary", includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON(),
  },
});
