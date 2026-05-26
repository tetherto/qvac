import {
  embed,
  loadModel,
  deleteCache,
  completion,
  ragIngest,
  transcribe,
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
      const { embedding: result } = await embed({ modelId: embeddingModelId, text: p.text });
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
}
