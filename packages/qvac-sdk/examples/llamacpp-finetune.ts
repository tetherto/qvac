import {
  finetune,
  pause,
  resume,
  QWEN3_600M_INST_Q4,
  loadModel,
  unloadModel,
} from "@qvac/sdk";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";

const shouldPauseAndResume = process.argv.includes("--pause-resume");
const runDir = path.join("/tmp", `qvac-finetune-${Date.now()}`);

let loadedModelId = "";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const datasetDir = path.join(runDir, "dataset");
  const outputDir = path.join(runDir, "output");
  const checkpointDir = path.join(runDir, "checkpoints");
  console.log(`📁 Temporary artifacts directory: ${runDir}`);
  mkdirSync(datasetDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(checkpointDir, { recursive: true });

  const trainDatasetPath = path.join(datasetDir, "train.jsonl");
  const evalDatasetPath = path.join(datasetDir, "eval.jsonl");

  const trainSamples = [
    {
      messages: [
        { role: "system", content: "You are a concise assistant." },
        { role: "user", content: "What is 2 + 2?" },
        { role: "assistant", content: "2 + 2 equals 4." },
      ],
    },
    {
      messages: [
        { role: "user", content: "What is the capital of France?" },
        { role: "assistant", content: "The capital of France is Paris." },
      ],
    },
    {
      messages: [
        { role: "user", content: "What color is a ripe banana?" },
        { role: "assistant", content: "A ripe banana is typically yellow." },
      ],
    },
  ];
  writeFileSync(
    trainDatasetPath,
    trainSamples.map((sample) => JSON.stringify(sample)).join("\n"),
    "utf-8",
  );

  const evalSamples = [
    {
      messages: [
        { role: "user", content: "What is the largest planet?" },
        { role: "assistant", content: "The largest planet is Jupiter." },
      ],
    },
  ];
  writeFileSync(
    evalDatasetPath,
    evalSamples.map((sample) => JSON.stringify(sample)).join("\n"),
    "utf-8",
  );

  console.log("🚀 Loading predefined model: QWEN3_600M_INST_Q4");
  loadedModelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelType: "llm",
    mode: "finetune",
    modelConfig: {
      ctx_size: 1024,
    },
  });
  console.log(`✅ Model loaded successfully! Model ID: ${loadedModelId}`);

  console.log("🚀 Starting finetuning...");
  const finetuneHandle = await finetune({
    modelId: loadedModelId,
    finetuningOptions: {
      trainDatasetDir: trainDatasetPath,
      validation: {
        type: "dataset",
        path: evalDatasetPath,
      },
      outputParametersDir: outputDir,
      numberOfEpochs: 2,
      learningRate: 1e-5,
      lrScheduler: "cosine",
      lrMin: 1e-8,
      warmupRatio: 0.1,
      warmupRatioSet: true,
      contextLength: 256,
      microBatchSize: 2,
      assistantLossOnly: true,
      loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
      checkpointSaveSteps: 2,
      checkpointSaveDir: checkpointDir,
    },
  });

  if (shouldPauseAndResume) {
    console.log("⏸️  Will request pause in 7 seconds...");
    await sleep(7_000);
    await pause({ modelId: loadedModelId });
  }

  let result = await finetuneHandle.await();
  console.log(`✅ Finetune status: ${result.status}`);

  if (result.status === "PAUSED") {
    console.log("▶️  Resuming finetuning...");
    const resumeHandle = await resume({ modelId: loadedModelId });
    result = await resumeHandle.await();
    console.log(`✅ Resume status: ${result.status}`);
  }

  if (result.status === "ERROR") {
    throw new Error("Finetuning ended with ERROR status");
  }

  console.log(
    `🎯 LoRA adapter output: ${path.join(outputDir, "trained-lora-adapter.gguf")}`,
  );

  await unloadModel({ modelId: loadedModelId });
  rmSync(runDir, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  if (loadedModelId) {
    await unloadModel({ modelId: loadedModelId }).catch(() => {});
  }
  rmSync(runDir, { recursive: true, force: true });
  console.error("❌ Error:", error);
  process.exit(1);
}
