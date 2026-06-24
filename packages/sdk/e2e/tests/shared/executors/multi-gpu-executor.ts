import {
  loadModel,
  unloadModel,
  completion,
  embed,
  LLAMA_3_2_1B_INST_Q4_0,
  EMBEDDINGGEMMA_300M_Q8_0,
} from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import type { ResourceManager } from "../resource-manager.js";
import {
  multiGpuConfigSmoke,
  multiGpuEmbedConfigSmoke,
  multiGpuTests,
} from "../../multi-gpu-tests.js";

export class MultiGpuExecutor extends AbstractModelExecutor<typeof multiGpuTests> {
  pattern = /^multi-gpu-/;

  constructor(resources: ResourceManager) {
    super(resources);
  }

  protected handlers = {
    [multiGpuConfigSmoke.testId]: this.llmLayerSplit.bind(this),
    [multiGpuEmbedConfigSmoke.testId]: this.embedLayerSplit.bind(this),
  };

  private async llmLayerSplit(
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string }>;
    };

    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llamacpp-completion",
      modelConfig: {
        ctx_size: 1024,
        verbosity: 0,
        gpu_layers: 99,
        "split-mode": "layer",
        "tensor-split": "1,1",
        "main-gpu": 0,
      },
    });

    try {
      const result = completion({ modelId, history: p.history, stream: false });
      const [text, stats] = await Promise.all([result.text, result.stats]);
      if (stats?.backendDevice !== "gpu") {
        return { passed: false, output: `Expected backendDevice=gpu, got ${stats?.backendDevice}` };
      }
      return ValidationHelpers.validate(text, expectation as Expectation);
    } finally {
      await unloadModel({ modelId, clearStorage: false });
    }
  }

  private async embedLayerSplit(
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const p = params as { text: string };

    const modelId = await loadModel({
      modelSrc: EMBEDDINGGEMMA_300M_Q8_0,
      modelType: "llamacpp-embedding",
      modelConfig: {
        gpuLayers: 99,
        verbosity: 0,
        splitMode: "layer",
        tensorSplit: "1,1",
        mainGpu: 0,
      },
    });

    try {
      const { embedding, stats } = await embed({ modelId, text: p.text });
      if (stats?.backendDevice !== "gpu") {
        return { passed: false, output: `Expected backendDevice=gpu, got ${stats?.backendDevice}` };
      }
      return ValidationHelpers.validate(embedding, expectation as Expectation);
    } finally {
      await unloadModel({ modelId, clearStorage: false });
    }
  }
}
