import {
  embed,
  loadModel,
  unloadModel,
  deleteCache,
  completion,
  ragIngest,
  transcribe,
  LLAMA_3_2_1B_INST_Q4_0,
  SDK_CLIENT_ERROR_CODES,
  SDK_SERVER_ERROR_CODES,
} from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { errorTests } from "../../error-tests.js";

export class ErrorExecutor extends AbstractModelExecutor<typeof errorTests> {
  pattern = /^error-/;

  protected handlers = Object.fromEntries(
    errorTests.map((test) => {
      const map: Record<string, (params: unknown, expectation: unknown) => Promise<TestResult>> = {
        "error-invalid-model-id": this.invalidModelId.bind(this),
        "error-invalid-response-type": this.invalidResponseType.bind(this),
        "error-model-load-failed": this.modelLoadFailed.bind(this),
        "error-delete-cache-invalid-params": this.deleteCacheInvalidParams.bind(this),
        "error-structured-error-code": this.structuredErrorCode.bind(this),
        "error-chaining-cause": this.chainingCause.bind(this),
        "error-rag-operation-failed": this.ragOperationFailed.bind(this),
        "error-transcription-failed": this.transcriptionFailed.bind(this),
        "error-use-unloaded-model": this.useUnloadedModel.bind(this),
        "error-rag-unloaded-model": this.ragUnloadedModel.bind(this),
        "error-embedding-empty-input": this.embeddingEmptyInput.bind(this),
        "error-memory-exceeded": this.memoryExceeded.bind(this),
        "error-memory-default-ctx-safe": this.memoryDefaultCtxSafe.bind(this),
        "error-memory-moderate-ctx-safe": this.memoryModerateCtxSafe.bind(this),
        "error-memory-recover-with-suggested": this.memoryRecoverWithSuggested.bind(this),
        "error-memory-load-after-rejection": this.memoryLoadAfterRejection.bind(this),
      };
      return [test.testId, map[test.testId] ?? this.completionError.bind(this)];
    }),
  ) as never;

  async invalidModelId(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelId: string };
    try {
      await embed({ modelId: p.modelId, text: "test text" });
      return { passed: false, output: "Expected error for invalid model ID" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async invalidResponseType(params: unknown, expectation: unknown): Promise<TestResult> {
    const code = SDK_CLIENT_ERROR_CODES?.INVALID_RESPONSE_TYPE;
    if (code) {
      return ValidationHelpers.validate(
        `SDK_CLIENT_ERROR_CODES.INVALID_RESPONSE_TYPE = ${code}`,
        expectation as Expectation,
      );
    }
    return ValidationHelpers.validate("SDK error codes not available", expectation as Expectation);
  }

  async modelLoadFailed(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelPath: string; modelType: string };
    try {
      await loadModel({ modelSrc: p.modelPath, modelType: p.modelType as "llm" });
      return { passed: false, output: "Expected error for invalid model path" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async deleteCacheInvalidParams(params: unknown, expectation: unknown): Promise<TestResult> {
    try {
      await deleteCache({} as never);
      return { passed: false, output: "Expected error for invalid deleteCache params" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async structuredErrorCode(params: unknown, expectation: unknown): Promise<TestResult> {
    const clientCount = SDK_CLIENT_ERROR_CODES ? Object.keys(SDK_CLIENT_ERROR_CODES).length : 0;
    const serverCount = SDK_SERVER_ERROR_CODES ? Object.keys(SDK_SERVER_ERROR_CODES).length : 0;
    return ValidationHelpers.validate(
      `Error codes: client=${clientCount}, server=${serverCount}`,
      expectation as Expectation,
    );
  }

  async chainingCause(params: unknown, expectation: unknown): Promise<TestResult> {
    try {
      await loadModel({ modelSrc: "/invalid/nonexistent/path/model.gguf", modelType: "llm" });
      return { passed: false, output: "Expected error" };
    } catch (error) {
      const e = error as Error & { cause?: unknown; code?: number };
      const hasCause = e.cause !== undefined;
      const isStructured = typeof e.code === "number";
      return { passed: hasCause || isStructured, output: `hasCause=${hasCause}, structured=${isStructured}` };
    }
  }

  async ragOperationFailed(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelId: string };
    try {
      await ragIngest({ modelId: p.modelId, documents: "test content" as never, workspace: "test" });
      return { passed: false, output: "Expected error for invalid RAG operation" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async transcriptionFailed(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioPath: string };
    const whisperModelId = await this.resources.ensureLoaded("whisper");
    try {
      await transcribe({ modelId: whisperModelId, audioChunk: p.audioPath });
      return { passed: false, output: "Expected error for invalid audio path" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async completionError(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string }>;
      stream?: boolean;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    };
    const llmModelId = await this.resources.ensureLoaded("llm");

    try {
      const result = completion({
        modelId: llmModelId,
        history: p.history,
        stream: p.stream ?? false,
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.topP !== undefined ? { topP: p.topP } : {}),
        ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
      });
      const text = p.stream
        ? await (async () => { let t = ""; for await (const tok of result.tokenStream) t += tok; return t; })()
        : await result.text;
      return ValidationHelpers.validate(text, expectation as Expectation);
    } catch (error) {
      const exp = expectation as Expectation;
      if (exp.validation === "throws-error") {
        return { passed: true, output: `Correctly threw: ${error}` };
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Error: ${errorMsg}` };
    }
  }

  async useUnloadedModel(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelIdOverride: string; history: Array<{ role: string; content: string }>; stream: boolean };
    try {
      const result = completion({ modelId: p.modelIdOverride, history: p.history, stream: p.stream });
      await result.text;
      return { passed: false, output: "Expected error for unloaded model" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async embeddingEmptyInput(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string };
    const embeddingModelId = await this.resources.ensureLoaded("embeddings");
    try {
      const result = await embed({ modelId: embeddingModelId, text: p.text });
      return ValidationHelpers.validate(result, expectation as Expectation);
    } catch (error) {
      return { passed: true, output: `SDK correctly rejected empty input: ${error}` };
    }
  }

  async ragUnloadedModel(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelIdOverride: string };
    try {
      await ragIngest({ modelId: p.modelIdOverride, documents: "test" as never, workspace: "test" });
      return { passed: false, output: "Expected error for unloaded embedding model" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async memoryDefaultCtxSafe(_params: unknown, _expectation: unknown): Promise<TestResult> {
    try {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0 },
      });
      await unloadModel({ modelId });
      return { passed: true, output: `Model loaded with default ctx_size and unloaded (id=${modelId})` };
    } catch (error) {
      const e = error as Error & { code?: number };
      return { passed: false, output: `Failed to load with default ctx_size: ${e.message ?? error}` };
    }
  }

  async memoryModerateCtxSafe(params: unknown, _expectation: unknown): Promise<TestResult> {
    const p = params as { ctx_size: number };
    try {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0, ctx_size: p.ctx_size },
      });
      await unloadModel({ modelId });
      return { passed: true, output: `Model loaded with ctx_size=${p.ctx_size} and unloaded (id=${modelId})` };
    } catch (error) {
      const e = error as Error & { code?: number };
      return { passed: false, output: `Failed to load with ctx_size=${p.ctx_size}: ${e.message ?? error}` };
    }
  }

  async memoryRecoverWithSuggested(params: unknown, _expectation: unknown): Promise<TestResult> {
    const p = params as { ctx_size: number };
    let suggestedCtxSize: number | undefined;

    try {
      await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0, ctx_size: p.ctx_size },
      });
      return { passed: false, output: `Expected MODEL_MEMORY_EXCEEDED but model loaded with ctx_size=${p.ctx_size}` };
    } catch (error) {
      const e = error as Error & { code?: number; suggestedCtxSize?: number };
      const isMemoryError =
        e.code === SDK_SERVER_ERROR_CODES.MODEL_MEMORY_EXCEEDED ||
        (e.message ?? "").includes("MODEL_MEMORY_EXCEEDED");
      if (!isMemoryError) {
        return { passed: false, output: `Wrong error (expected MODEL_MEMORY_EXCEEDED): ${e.message ?? error}` };
      }
      suggestedCtxSize = e.suggestedCtxSize;
      if (!suggestedCtxSize) {
        const match = (e.message ?? "").match(/to (\d+)/);
        suggestedCtxSize = match ? Number(match[1]) : undefined;
      }
    }

    if (!suggestedCtxSize || suggestedCtxSize <= 0) {
      return { passed: false, output: "MODEL_MEMORY_EXCEEDED thrown but no usable suggestedCtxSize found" };
    }

    try {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0, ctx_size: suggestedCtxSize },
      });
      await unloadModel({ modelId });
      return {
        passed: true,
        output: `Recovered: rejected ctx_size=${p.ctx_size}, loaded with suggested=${suggestedCtxSize}`,
      };
    } catch (error) {
      const e = error as Error;
      return {
        passed: false,
        output: `suggestedCtxSize=${suggestedCtxSize} also failed: ${e.message ?? error}`,
      };
    }
  }

  async memoryLoadAfterRejection(params: unknown, _expectation: unknown): Promise<TestResult> {
    const p = params as { ctx_size: number };

    try {
      await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0, ctx_size: p.ctx_size },
      });
      return { passed: false, output: `Expected MODEL_MEMORY_EXCEEDED but model loaded with ctx_size=${p.ctx_size}` };
    } catch (error) {
      const e = error as Error & { code?: number };
      const isMemoryError =
        e.code === SDK_SERVER_ERROR_CODES.MODEL_MEMORY_EXCEEDED ||
        (e.message ?? "").includes("MODEL_MEMORY_EXCEEDED");
      if (!isMemoryError) {
        return { passed: false, output: `Wrong error (expected MODEL_MEMORY_EXCEEDED): ${e.message ?? error}` };
      }
    }

    try {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0 },
      });
      await unloadModel({ modelId });
      return {
        passed: true,
        output: `SDK recovered: rejected extreme ctx_size, then loaded default ctx_size successfully`,
      };
    } catch (error) {
      const e = error as Error;
      return {
        passed: false,
        output: `SDK broken after rejection — default load failed: ${e.message ?? error}`,
      };
    }
  }

  async memoryExceeded(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { ctx_size: number };
    try {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        modelConfig: { verbosity: 0, ctx_size: p.ctx_size },
      });
      await unloadModel({ modelId });
      return {
        passed: false,
        output: `Expected MODEL_MEMORY_EXCEEDED error but model loaded successfully with ctx_size=${p.ctx_size}`,
      };
    } catch (error) {
      const e = error as Error & { code?: number };
      const errorMsg = e.message ?? String(error);
      const isMemoryError =
        e.code === SDK_SERVER_ERROR_CODES.MODEL_MEMORY_EXCEEDED ||
        errorMsg.includes("MODEL_MEMORY_EXCEEDED");
      if (isMemoryError) {
        return {
          passed: true,
          output: `MODEL_MEMORY_EXCEEDED correctly thrown: ${errorMsg}`,
        };
      }
      return {
        passed: false,
        output: `Wrong error type (expected MODEL_MEMORY_EXCEEDED): ${errorMsg}`,
      };
    }
  }
}
