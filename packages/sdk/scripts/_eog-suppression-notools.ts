/**
 * Diagnostic-only sibling of `smoke-native-tool-formats.ts`. Loads Qwen3
 * 1.7B WITHOUT `tools: true`, so we can verify whether the load-time
 * EOG-suppression (`common_init_from_model_and_params: added <X> logit
 * bias = -inf`) is gated on `tools: true` (which flips
 * `params.use_jinja = true`) or happens unconditionally.
 *
 * Run from packages/sdk:
 *   bun run scripts/_eog-suppression-notools.ts
 */

import { loadModel, unloadModel, QWEN3_1_7B_INST_Q4 } from "@/index";

let modelId: string | undefined;
try {
  modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelType: "llm",
    modelConfig: { ctx_size: 4096, verbosity: 3 },
  });
  console.log(`[load] done — modelId=${modelId}\n`);
} catch (error) {
  console.error("[smoke] error:", error);
  process.exitCode = 1;
} finally {
  if (modelId) {
    try {
      await unloadModel({ modelId, clearStorage: false });
      console.log(`[unload] done`);
    } catch (unloadError) {
      console.error("[unload] failed:", unloadError);
    }
  }
}
