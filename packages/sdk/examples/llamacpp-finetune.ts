/**
 * LLM LoRA Finetuning Example (Option B — no separate resume/cancel API)
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
  cancel,
  unloadModel,
  completion,
} from "@qvac/sdk";
import process from "bare-process";
import fs from "bare-fs";
import path from "bare-path";

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
      // Cancel with reset: true — clears checkpoints, cannot resume
      await cancel({ operation: "inference", modelId, reset: true });
      break;
    }
  }

  const result = await handle.result;
  console.log(`Result: ${result.status}`); // → "CANCELLED"
  console.log("Checkpoints cleared — cannot resume after cancel.\n");
}

function findPauseCheckpoint(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir) as string[];
  const checkpoints = entries.filter((f: string) => f.startsWith("pause_checkpoint_step_"));
  if (checkpoints.length === 0) return null;
  checkpoints.sort((a: string, b: string) => {
    const stepA = parseInt(a.match(/pause_checkpoint_step_(\d+)/)?.[1] ?? "0");
    const stepB = parseInt(b.match(/pause_checkpoint_step_(\d+)/)?.[1] ?? "0");
    return stepB - stepA;
  });
  return path.join(dir, checkpoints[0]!);
}

const inferencePrompt = [
  { role: "system" as const, content: "You are a helpful healthcare assistant." },
  { role: "user" as const, content: "Do nurses' involvement in patient education improve outcomes?" },
];

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
      // cancel() with reset: false acts as pause for finetune jobs
      await cancel({ operation: "inference", modelId, reset: false });
      break;
    }
  }

  const pauseResult = await handle.result;
  console.log(`Pause result: ${pauseResult.status}`);

  if (pauseResult.stats) {
    console.log("Stats at pause:", JSON.stringify(pauseResult.stats, null, 2));
  }

  // Find the pause checkpoint's LoRA adapter
  const pauseCheckpointPath = findPauseCheckpoint(checkpointDir);
  if (!pauseCheckpointPath) {
    throw new Error(`No pause checkpoint found in ${checkpointDir}`);
  }
  const loraAdapterPath = path.join(pauseCheckpointPath, "model.gguf");
  console.log(`\nPause checkpoint found: ${pauseCheckpointPath}`);
  console.log(`LoRA adapter path: ${loraAdapterPath}`);

  // Step 1: Inference WITH the checkpoint's LoRA adapter
  // This demonstrates partial fine-tuning effect
  console.log("\n--- Inference with LoRA adapter (partial fine-tuning) ---");
  const loraModelId = await loadModel({
    modelType: "llm",
    modelSrc: modelPath,
    modelConfig: {
      device: "cpu",
      ctx_size: 4096,
      lora: loraAdapterPath,
    },
  });

  const { text: loraText } = completion({
    modelId: loraModelId,
    history: inferencePrompt,
    stream: false,
  });
  console.log("With LoRA:", await loraText);
  await unloadModel({ modelId: loraModelId });

  // Step 2: Inference WITHOUT LoRA (base model comparison)
  console.log("\n--- Inference without LoRA (base model) ---");
  const baseModelId = await loadModel({
    modelType: "llm",
    modelSrc: modelPath,
    modelConfig: {
      device: "cpu",
      ctx_size: 4096,
    },
  });

  const { text: baseText } = completion({
    modelId: baseModelId,
    history: inferencePrompt,
    stream: false,
  });
  console.log("Without LoRA:", await baseText);
  await unloadModel({ modelId: baseModelId });

  // Step 3: Resume finetuning on the ORIGINAL model (never unloaded)
  // The addon auto-detects the checkpoint in checkpointSaveDir
  console.log("\n--- Resuming finetuning from checkpoint ---");
  const resumed = finetune({ modelId, ...finetuneOptions });

  for await (const tick of resumed.progressStream) {
    logProgress(tick);
  }

  const resumeResult = await resumed.result;
  console.log(`\nResume result: ${resumeResult.status}`);

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
