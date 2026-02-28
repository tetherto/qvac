import { createExecutor } from "@tetherto/qvac-test-suite";
import {
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  QWEN3_1_7B_INST_Q4,
} from "@qvac/sdk";
import { ResourceManager } from "../shared/resource-manager.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { CompletionExecutor } from "./executors/completion-executor.js";
import { TranscriptionExecutor } from "./executors/transcription-executor.js";
import { EmbeddingExecutor } from "./executors/embedding-executor.js";
import { RagExecutor } from "./executors/rag-executor.js";
import { TranslationExecutor } from "./executors/translation-executor.js";
import { CacheExecutor } from "./executors/cache-executor.js";
import { ErrorExecutor } from "./executors/error-executor.js";
import { ToolsExecutor } from "./executors/tools-executor.js";
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
  ],
});
