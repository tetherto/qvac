import {
  finetune,
  loadModel,
  QWEN3_600M_INST_Q4,
  unloadModel,
  type FinetuneHandle,
  type FinetuneResult,
  type FinetuneRunParams,
} from "@qvac/sdk";

const pauseResumeEnabled = process.argv.includes("--pause-resume");

let modelId: string | undefined;
let exitCode = 0;

async function readProgress(
  handle: FinetuneHandle,
  onTick: (globalSteps: number) => void,
) {
  for await (const tick of handle.progressStream) {
    const phase = tick.is_train ? "train" : "val";
    console.log(
      `epoch=${tick.current_epoch + 1} step=${tick.global_steps} batch=${tick.current_batch}/${tick.total_batches} ${phase} loss=${tick.loss?.toFixed(4)} acc=${tick.accuracy?.toFixed(4)} eta=${Math.round(tick.eta_ms / 1000)}s`,
    );

    onTick(tick.global_steps);
  }
}

try {
  modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelType: "llm",
    modelConfig: {
      device: "gpu",
      ctx_size: 512,
    },
  });

  console.log(`✅ Model loaded with ID: ${modelId}`);
  const loadedModelId = modelId;

  const finetuneParams: FinetuneRunParams = {
    modelId: loadedModelId,
    options: {
      trainDatasetDir: "./examples/finetune/input/small_train_HF.jsonl",
      validation: {
        type: "dataset",
        path: "./examples/finetune/input/small_eval_HF.jsonl",
      },
      numberOfEpochs: 2,
      learningRate: 1e-4,
      lrMin: 1e-8,
      loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
      assistantLossOnly: true,
      checkpointSaveSteps: 2,
      checkpointSaveDir: "./examples/finetune/results/checkpoints",
      outputParametersDir: "./examples/finetune/results",
    },
  };

  const handle = finetune(finetuneParams);
  let pauseRequested = false;
  let pauseResultPromise: Promise<FinetuneResult> | undefined;

  const progressTask = readProgress(handle, (globalSteps) => {
    if (pauseResumeEnabled && !pauseRequested && globalSteps >= 10) {
      pauseRequested = true;
      console.log("⏸️ Requesting a pause so the run can be resumed...");
      pauseResultPromise = finetune({ modelId: loadedModelId, operation: "pause" });
    }
  });

  const initialResult = await handle.result;
  await progressTask;

  if (pauseResultPromise) {
    await pauseResultPromise;
  }

  console.log("📦 Initial finetune result:", initialResult);

  if (pauseResumeEnabled && initialResult.status === "PAUSED") {
    console.log("▶️ Resuming from the saved checkpoint...");

    const resumedHandle = finetune({
      ...finetuneParams,
      operation: "resume",
    });
    const resumedProgressTask = readProgress(resumedHandle, function () { });

    const resumedResult = await resumedHandle.result;
    await resumedProgressTask;

    console.log("✅ Resumed finetune result:", resumedResult);
  }
} catch (error) {
  console.error("❌ Error:", error);
  exitCode = 1;
} finally {
  if (modelId) {
    await unloadModel({ modelId, clearStorage: false });
  }
}

process.exit(exitCode);
