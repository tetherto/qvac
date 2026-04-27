import {
  loadModel,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  OCR_LATIN_RECOGNIZER_1,
} from "@qvac/sdk";
import { ValidationHelpers, type TestResult } from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import {
  modelLoadLlm,
  modelLoadEmbedding,
  modelLoadOcr,
  modelLoadInvalid,
  modelUnload,
  modelLoadConcurrent,
  modelReloadLlm,
  modelSwitchLlm,
  modelReloadAfterError,
  modelLoadInferredType,
  modelLoadMissingTypeStringSrc,
} from "../../test-definitions.js";

const modelLoadTests = [
  modelLoadLlm,
  modelLoadEmbedding,
  modelLoadOcr,
  modelLoadInvalid,
  modelUnload,
  modelLoadConcurrent,
  modelReloadLlm,
  modelSwitchLlm,
  modelReloadAfterError,
  modelLoadInferredType,
  modelLoadMissingTypeStringSrc,
] as const;

export class ModelLoadingExecutor extends AbstractModelExecutor<
  typeof modelLoadTests
> {
  pattern = /^model-(?!info-)/;
  private llmModelId: string | null = null;

  protected handlers = {
    [modelLoadLlm.testId]: this.loadLlm.bind(this),
    [modelLoadEmbedding.testId]: this.loadEmbedding.bind(this),
    [modelLoadOcr.testId]: this.loadOcr.bind(this),
    [modelLoadInvalid.testId]: this.loadInvalid.bind(this),
    [modelUnload.testId]: this.unload.bind(this),
    [modelLoadConcurrent.testId]: this.loadConcurrent.bind(this),
    [modelReloadLlm.testId]: this.reloadLlm.bind(this),
    [modelSwitchLlm.testId]: this.switchLlm.bind(this),
    [modelReloadAfterError.testId]: this.reloadAfterError.bind(this),
    [modelLoadInferredType.testId]: this.loadInferredType.bind(this),
    [modelLoadMissingTypeStringSrc.testId]:
      this.loadMissingTypeStringSrc.bind(this),
  };

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
    this.resources.register("llm", modelId);
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
    this.resources.register("embeddings", modelId);
    return ValidationHelpers.validate(modelId, expectation);
  }

  async loadOcr(
    params: typeof modelLoadOcr.params,
    expectation: typeof modelLoadOcr.expectation,
  ): Promise<TestResult> {
    const modelId = await loadModel({
      modelSrc: OCR_LATIN_RECOGNIZER_1,
      modelType: "ocr",
      modelConfig: { langList: ["en"] },
    });
    this.resources.register("ocr", modelId);
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
    this.resources.unregister(this.llmModelId);
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
        this.resources.register("llm", modelId);
      } else {
        modelId = await loadModel({
          modelSrc,
          modelType: "embeddings",
        });
        this.resources.register("embeddings", modelId);
      }
      modelIds.push(modelId);
    }
    return ValidationHelpers.validate(modelIds, expectation);
  }

  async reloadLlm(
    params: typeof modelReloadLlm.params,
    expectation: typeof modelReloadLlm.expectation,
  ): Promise<TestResult> {
    this.llmModelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    this.resources.register("llm", this.llmModelId);
    return ValidationHelpers.validate(this.llmModelId, expectation);
  }

  async switchLlm(
    params: typeof modelSwitchLlm.params,
    expectation: typeof modelSwitchLlm.expectation,
  ): Promise<TestResult> {
    if (this.llmModelId) {
      await unloadModel({ modelId: this.llmModelId });
      this.resources.unregister(this.llmModelId);
    }
    this.llmModelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    this.resources.register("llm", this.llmModelId);
    return ValidationHelpers.validate(this.llmModelId, expectation);
  }

  async reloadAfterError(
    params: typeof modelReloadAfterError.params,
    expectation: typeof modelReloadAfterError.expectation,
  ): Promise<TestResult> {
    if (this.llmModelId) {
      await unloadModel({ modelId: this.llmModelId });
      this.resources.unregister(this.llmModelId);
    }
    this.llmModelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    this.resources.register("llm", this.llmModelId);
    return ValidationHelpers.validate(this.llmModelId, expectation);
  }

  async loadInferredType(
    params: typeof modelLoadInferredType.params,
    expectation: typeof modelLoadInferredType.expectation,
  ): Promise<TestResult> {
    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelConfig: { verbosity: 0, ctx_size: 2048, n_discarded: 256 },
    });
    this.llmModelId = modelId;
    this.resources.register("llm", modelId);
    return ValidationHelpers.validate(modelId, expectation);
  }

  async loadMissingTypeStringSrc(
    params: typeof modelLoadMissingTypeStringSrc.params,
    expectation: typeof modelLoadMissingTypeStringSrc.expectation,
  ): Promise<TestResult> {
    try {
      await loadModel({
        modelSrc: params.modelPath,
      } as unknown as Parameters<typeof loadModel>[0]);
      return {
        passed: false,
        output: "Should have thrown ModelTypeRequiredError for plain-string modelSrc without modelType",
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : JSON.stringify(error);
      return ValidationHelpers.validate(errorMsg, expectation);
    }
  }
}
