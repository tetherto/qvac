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
} from "@qvac/sdk";
import { ResourceManager } from "../shared/resource-manager.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { CompletionExecutor } from "../shared/executors/completion-executor.js";
import { TranslationExecutor } from "../shared/executors/translation-executor.js";
import { ToolsExecutor } from "../shared/executors/tools-executor.js";
import { NmtExecutor } from "../shared/executors/nmt-executor.js";
import { BergamotExecutor } from "../shared/executors/bergamot-executor.js";
import { ShardedModelExecutor } from "../shared/executors/sharded-model-executor.js";
import { EmbeddingExecutor } from "../shared/executors/embedding-executor.js";
import { TranscriptionExecutor } from "./executors/transcription-executor.js";
import { RagExecutor } from "./executors/rag-executor.js";
import { CacheExecutor } from "./executors/cache-executor.js";
import { ErrorExecutor } from "./executors/error-executor.js";
import { TodoExecutor } from "./executors/todo-executor.js";

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

export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(resources),
    new CompletionExecutor(resources),
    new TranscriptionExecutor(resources),
    new EmbeddingExecutor(resources),
    new RagExecutor(resources),
    new TranslationExecutor(resources),
    new CacheExecutor(),
    new ErrorExecutor(),
    new ToolsExecutor(resources),
    new TodoExecutor(),
    new NmtExecutor(resources),
    new BergamotExecutor(resources),
    new ShardedModelExecutor(resources),
  ],
});
