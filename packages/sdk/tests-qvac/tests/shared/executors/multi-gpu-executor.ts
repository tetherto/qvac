import { loadModel, unloadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";
import {
  BaseExecutor,
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { multiGpuTests } from "../../multi-gpu-tests.js";

export class MultiGpuExecutor extends BaseExecutor<typeof multiGpuTests> {
  pattern = /^multi-gpu-/;

  protected handlers = {
    "multi-gpu-config-smoke": this.configSmoke.bind(this),
  } as never;

  private async configSmoke(
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
      const text = await result.text;
      return ValidationHelpers.validate(text, expectation as Expectation);
    } finally {
      await unloadModel({ modelId, clearStorage: false });
    }
  }
}
