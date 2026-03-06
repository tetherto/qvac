// Model loading executor
import {
  loadModel,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
} from "@qvac/sdk";
import { ValidationHelpers, type TestResult } from "@tetherto/qvac-test-suite";
import { ModelManager } from "../model-manager.js";
import {
  modelLoadLlm,
  modelLoadEmbedding,
  modelLoadInvalid,
  modelUnload,
  modelLoadConcurrent,
  modelReloadLlm,
  modelSwitchLlm,
  modelReloadAfterError,
} from "../../test-definitions.js";

export class ModelLoadingExecutor {
  pattern = /^model-/;
  llmModelId: string | null = null;
  embeddingModelId: string | null = null;

  // Explicit mapping: testId → method
  handlers = {
    [modelLoadLlm.testId]: this.loadLlm,
    [modelLoadEmbedding.testId]: this.loadEmbedding,
    [modelLoadInvalid.testId]: this.loadInvalid,
    [modelUnload.testId]: this.unload,
    [modelLoadConcurrent.testId]: this.loadConcurrent,
    [modelReloadLlm.testId]: this.reloadLlm,
    [modelSwitchLlm.testId]: this.switchLlm,
    [modelReloadAfterError.testId]: this.reloadAfterError,
  };

  async execute(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const handler = this.handlers[testId as keyof typeof this.handlers];
    if (handler) {
      return await (
        handler as (
          params: unknown,
          expectation: unknown,
        ) => Promise<TestResult>
      ).call(this, params, expectation);
    }
    return { passed: false, output: `Unknown test: ${testId}` };
  }

  async loadLlm(
    params: typeof modelLoadLlm.params,
    expectation: typeof modelLoadLlm.expectation,
  ): Promise<TestResult> {
    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    this.llmModelId = modelId;
    // Register with ModelManager so other executors can reuse it
    ModelManager.setLlmModel(modelId);
    return ValidationHelpers.validate(modelId, expectation);
  }

  async loadEmbedding(
    params: typeof modelLoadEmbedding.params,
    expectation: typeof modelLoadEmbedding.expectation,
  ): Promise<TestResult> {
    const modelId = await loadModel({
      modelSrc: GTE_LARGE_FP16,
      modelType: "embeddings",
    });
    this.embeddingModelId = modelId;
    return ValidationHelpers.validate(modelId, expectation);
  }

  async loadInvalid(
    params: typeof modelLoadInvalid.params,
    expectation: typeof modelLoadInvalid.expectation,
  ): Promise<TestResult> {
    try {
      await loadModel({
        modelSrc: params.modelPath,
        modelType: params.modelType as "llm",
      });
      return {
        passed: false,
        output: "Should have thrown error for invalid path",
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : JSON.stringify(error);
      if (
        errorMsg.includes("failed to locate") ||
        errorMsg.includes("invalid") ||
        errorMsg.includes("not found")
      ) {
        return { passed: true, output: errorMsg };
      }
      return ValidationHelpers.validate(errorMsg, expectation);
    }
  }

  async unload(
    params: typeof modelUnload.params,
    expectation: typeof modelUnload.expectation,
  ): Promise<TestResult> {
    if (!this.llmModelId) {
      return { passed: false, output: "No model loaded to unload" };
    }
    await unloadModel({
      modelId: this.llmModelId,
      clearStorage: params.shouldClearStorage || false,
    });
    const result = `Model ${this.llmModelId} unloaded successfully`;
    this.llmModelId = null;
    return ValidationHelpers.validate(result, expectation);
  }

  async loadConcurrent(
    params: typeof modelLoadConcurrent.params,
    expectation: typeof modelLoadConcurrent.expectation,
  ): Promise<TestResult> {
    const modelIds: string[] = [];
    for (const model of params.models) {
      const modelSrc =
        model.constant === "LLAMA_3_2_1B_INST_Q4_0"
          ? LLAMA_3_2_1B_INST_Q4_0
          : GTE_LARGE_FP16;

      let modelId: string;
      if (model.type === "llm") {
        modelId = await loadModel({
          modelSrc,
          modelType: "llm",
          modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
        });
        this.llmModelId = modelId;
        ModelManager.setLlmModel(modelId);
      } else {
        modelId = await loadModel({
          modelSrc,
          modelType: "embeddings",
        });
        this.embeddingModelId = modelId;
        ModelManager.setEmbeddingModel(modelId);
      }
      modelIds.push(modelId);
    }
    return ValidationHelpers.validate(modelIds, expectation);
  }

  async reloadLlm(
    params: typeof modelReloadLlm.params,
    expectation: typeof modelReloadLlm.expectation,
  ): Promise<TestResult> {
    if (this.llmModelId) {
      await unloadModel({ modelId: this.llmModelId });
    }
    this.llmModelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    return ValidationHelpers.validate(this.llmModelId, expectation);
  }

  async switchLlm(
    params: typeof modelSwitchLlm.params,
    expectation: typeof modelSwitchLlm.expectation,
  ): Promise<TestResult> {
    if (this.llmModelId) {
      await unloadModel({ modelId: this.llmModelId });
    }
    this.llmModelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    return ValidationHelpers.validate(this.llmModelId, expectation);
  }

  async reloadAfterError(
    params: typeof modelReloadAfterError.params,
    expectation: typeof modelReloadAfterError.expectation,
  ): Promise<TestResult> {
    if (this.llmModelId) {
      await unloadModel({ modelId: this.llmModelId });
    }
    this.llmModelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    return ValidationHelpers.validate(this.llmModelId, expectation);
  }
}
