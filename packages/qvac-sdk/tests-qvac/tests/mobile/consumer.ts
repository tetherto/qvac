import { createExecutor } from "@tetherto/qvac-test-suite/mobile";
import { LLAMA_3_2_1B_INST_Q4_0, GTE_LARGE_FP16, WHISPER_TINY } from "@qvac/sdk";
import { ResourceManager } from "../shared/resource-manager.js";
import { ModelLoadingExecutor } from "../shared/executors/model-loading-executor.js";
import { MobileTranscriptionExecutor } from "./executors/transcription-executor.js";

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
});

export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(resources),
    new MobileTranscriptionExecutor(resources),
  ],
});
