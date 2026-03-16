import { createExecutor } from "@tetherto/qvac-test-suite";
import {
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  GTE_LARGE_335M_FP16_SHARD,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  QWEN3_1_7B_INST_Q4,
  OCR_LATIN_RECOGNIZER_1,
  MARIAN_OPUS_DE_EN_Q4_0,
  BERGAMOT_EN_FR,
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
} from "@qvac/sdk";
import * as path from "node:path";
import { ResourceManager } from "../shared/resource-manager.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { CompletionExecutor } from "../shared/executors/completion-executor.js";
import { TranslationExecutor } from "../shared/executors/translation-executor.js";
import { ToolsExecutor } from "../shared/executors/tools-executor.js";
import { NmtExecutor } from "../shared/executors/nmt-executor.js";
import { BergamotExecutor } from "../shared/executors/bergamot-executor.js";
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

resources.define("nmt", {
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

resources.define("bergamot", {
  constant: BERGAMOT_EN_FR,
  type: "nmt",
  config: {
    engine: "Bergamot",
    from: "en",
    to: "fr",
  },
});

const referenceAudioPath = path.resolve(process.cwd(), "assets/audio/transcription-short.wav");

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

export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(resources),
    new CompletionExecutor(resources),
    new TranscriptionExecutor(resources),
    new EmbeddingExecutor(resources),
    new RagExecutor(resources),
    new TranslationExecutor(resources),
    new ModelInfoExecutor(resources),
    new ErrorExecutor(resources),
    new ToolsExecutor(resources),

    new NmtExecutor(resources),
    new BergamotExecutor(resources),
    new ShardedModelExecutor(resources),
    new OcrExecutor(resources),
    new TtsExecutor(resources),
    new ConfigReloadExecutor(resources),
    new LoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
  ],
});
