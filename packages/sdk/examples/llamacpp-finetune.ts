/**
 * LLM LoRA Finetuning Example (Option A — op-based API)
 *
 * Demonstrates the full finetuning lifecycle using the SDK:
 *   1. Load a model
 *   2. Start finetuning with progress streaming
 *   3. Pause and resume via checkpoint auto-detection
 *   4. Cancel (hard cancel — clears checkpoints)
 *   5. Load the finetuned adapter for inference
 *
 * Parameters match the addon's tested examples (qvac-lib-infer-llamacpp-llm).
 *
 * Usage:
 *   # Full run (no pause):
 *   bun run bare:example examples/llamacpp-finetune.ts -- \
 *     --model /models/Qwen3-0.6B-Q8_0.gguf \
 *     --dataset /data/train.jsonl \
 *     --eval-dataset /data/eval.jsonl \
 *     --output /output/lora
 *
 *   # Pause/resume demo (pauses after 5 steps, then resumes):
 *   bun run bare:example examples/llamacpp-finetune.ts -- \
 *     --model /models/Qwen3-0.6B-Q8_0.gguf \
 *     --dataset /data/train.jsonl \
 *     --eval-dataset /data/eval.jsonl \
 *     --output /output/lora \
 *     --pause-after 5
 *
 *   # Cancel demo (cancels after 3 steps — clears checkpoints):
 *   bun run bare:example examples/llamacpp-finetune.ts -- \
 *     --model /models/Qwen3-0.6B-Q8_0.gguf \
 *     --dataset /data/train.jsonl \
 *     --eval-dataset /data/eval.jsonl \
 *     --output /output/lora \
 *     --cancel-after 3
 */

import {
  loadModel,
  finetune,
  unloadModel,
  completion,
} from "@qvac/sdk";
import process from "bare-process";

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]!;
  return fallback;
}
const modelPath: string = getArg("model", "/models/Qwen3-0.6B-Q8_0.gguf");
const datasetPath: string = getArg("dataset", "/data/train.jsonl");
const evalDatasetPath: string = getArg("eval-dataset", "");
const outputDir: string = getArg("output", "/output/lora");
const checkpointDir: string = getArg("checkpoint-dir", "./lora_checkpoints");
const pauseAfterSteps: number = parseInt(getArg("pause-after", "0"), 10);
const cancelAfterSteps: number = parseInt(getArg("cancel-after", "0"), 10);

// Matches addon example parameters from qvac-lib-infer-llamacpp-llm
const finetuneOptions = {
  trainDatasetDir: datasetPath,
  validation: evalDatasetPath
    ? { type: "dataset" as const, path: evalDatasetPath }
    : { type: "split" as const, fraction: 0.25 },
  outputParametersDir: outputDir,
  numberOfEpochs: 2,
  learningRate: 1e-5,
  lrMin: 1e-8,
  contextLength: 512,
  loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
  assistantLossOnly: true,
  checkpointSaveSteps: 10,
  checkpointSaveDir: checkpointDir,
};

function logProgress(tick: {
  is_train: boolean;
  global_steps: number;
  current_epoch: number;
  current_batch: number;
  total_batches: number;
  loss: number;
  accuracy: number;
  elapsed_ms: number;
  eta_ms: number;
}) {
  const mode = tick.is_train ? "train" : "val";
  console.log(
    `[${mode}] step ${tick.global_steps} | ` +
      `epoch ${tick.current_epoch} batch ${tick.current_batch}/${tick.total_batches} | ` +
      `loss: ${tick.loss.toFixed(4)} | acc: ${tick.accuracy.toFixed(4)} | ` +
      `elapsed: ${(tick.elapsed_ms / 1000).toFixed(1)}s | eta: ${(tick.eta_ms / 1000).toFixed(1)}s`,
  );
}

async function demoCancel(modelId: string) {
  console.log("\n=== Cancel Demo ===");
  console.log("Starting finetuning (will cancel after a few steps)...");

  const handle = finetune({ modelId, ...finetuneOptions });
  let stepCount = 0;

  for await (const tick of handle.progressStream) {
    logProgress(tick);
    stepCount++;

    if (stepCount >= cancelAfterSteps) {
      console.log(`\nHard-cancelling after ${stepCount} steps...`);
      // Option A: op-based cancel — clears checkpoints, cannot resume
      await finetune({ op: "cancel", modelId });
      break;
    }
  }

  const result = await handle.result;
  console.log(`Result: ${result.status}`); // → "CANCELLED"
  console.log("Checkpoints cleared — cannot resume after cancel.\n");
}

async function demoPauseResume(modelId: string) {
  console.log("\n=== Pause/Resume Demo ===");
  console.log("Starting finetuning (will pause after a few steps)...");

  // Start finetuning
  const handle = finetune({ modelId, ...finetuneOptions });
  let stepCount = 0;

  for await (const tick of handle.progressStream) {
    logProgress(tick);
    stepCount++;

    if (stepCount >= pauseAfterSteps) {
      console.log(`\nPausing after ${stepCount} steps...`);
      // Option A: op-based pause — saves checkpoint, can resume
      await finetune({ op: "pause", modelId });
      break;
    }
  }

  const pauseResult = await handle.result;
  console.log(`Pause result: ${pauseResult.status}`); // → "PAUSED"

  if (pauseResult.stats) {
    console.log("Stats at pause:", JSON.stringify(pauseResult.stats, null, 2));
  }

  // (Optional) Run inference while paused
  console.log("\nRunning inference while finetuning is paused...");
  const { text: inferText } = completion({
    modelId,
    history: [{ role: "user", content: "What is 2+2?" }],
    stream: false,
  });
  console.log("Inference response:", await inferText);

  // Resume — just call finetune() again with the same params
  // The addon auto-detects the checkpoint in checkpointSaveDir
  console.log("\nResuming finetuning from checkpoint...");
  const resumed = finetune({ modelId, ...finetuneOptions });

  for await (const tick of resumed.progressStream) {
    logProgress(tick);
  }

  const resumeResult = await resumed.result;
  console.log(`\nResume result: ${resumeResult.status}`); // → "COMPLETED"

  if (resumeResult.stats) {
    console.log("Final stats:", JSON.stringify(resumeResult.stats, null, 2));
  }
}

async function demoFullRun(modelId: string) {
  console.log("\n=== Full Finetuning Run ===");
  const handle = finetune({ modelId, ...finetuneOptions });

  for await (const tick of handle.progressStream) {
    logProgress(tick);
  }

  const result = await handle.result;
  console.log(`\nResult: ${result.status}`); // → "COMPLETED"

  if (result.stats) {
    console.log("Stats:", JSON.stringify(result.stats, null, 2));
  }
}

async function main() {
  // ──────────────────────────────────────────────
  // 1. Load the base model
  // ──────────────────────────────────────────────
  console.log("Loading model...");
  const modelId = await loadModel({
    modelType: "llm",
    modelSrc: modelPath,
    modelConfig: {
      device: "cpu",
      ctx_size: 512,
    },
  });
  console.log(`Model loaded: ${modelId}`);

  // ──────────────────────────────────────────────
  // 2. Run the appropriate demo
  // ──────────────────────────────────────────────
  if (cancelAfterSteps > 0) {
    await demoCancel(modelId);
  } else if (pauseAfterSteps > 0) {
    await demoPauseResume(modelId);
  } else {
    await demoFullRun(modelId);
  }

  // ──────────────────────────────────────────────
  // 3. Load the finetuned adapter for inference
  // ──────────────────────────────────────────────
  if (cancelAfterSteps === 0) {
    console.log("\n=== Inference with Finetuned Adapter ===");
    await unloadModel({ modelId });

    console.log("Loading model with LoRA adapter...");
    const ftModelId = await loadModel({
      modelType: "llm",
      modelSrc: modelPath,
      modelConfig: {
        device: "cpu",
        ctx_size: 128,
        lora: `${outputDir}/trained-lora-adapter.gguf`,
      },
    });

    const { text } = completion({
      modelId: ftModelId,
      history: [{ role: "user", content: "Hello, how are you?" }],
      stream: false,
    });
    console.log("Response:", await text);

    await unloadModel({ modelId: ftModelId });
  } else {
    await unloadModel({ modelId });
  }

  console.log("\nDone!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
