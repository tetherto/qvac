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

interface GenerationParams {
  temp?: number;
  top_p?: number;
  top_k?: number;
  predict?: number;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
  reasoning_budget?: -1 | 0;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface InvalidModelIdParams {
  modelId: string;
}

interface ModelLoadFailedParams {
  modelPath: string;
  modelType: string;
}

interface RagOperationFailedParams {
  modelId: string;
}

interface TranscriptionFailedParams {
  audioPath: string;
}

interface CompletionErrorParams {
  history: ChatMessage[];
  stream?: boolean;
  generationParams?: GenerationParams;
}

interface UseUnloadedModelParams {
  modelIdOverride: string;
  history: ChatMessage[];
  stream: boolean;
}

interface EmbeddingEmptyInputParams {
  text: string;
}

interface RagUnloadedModelParams {
  modelIdOverride: string;
}

interface VerifyErrorCodesParams {
  verifyErrorCodes: boolean;
}

export class ErrorExecutor extends AbstractModelExecutor<typeof errorTests> {
  pattern = /^error-/;

  protected handlers = Object.fromEntries(
    errorTests.map((test) => {
      switch (test.testId) {
        case "error-invalid-model-id":
          return [test.testId, this.invalidModelId.bind(this)];
        case "error-invalid-response-type":
          return [test.testId, this.invalidResponseType.bind(this)];
        case "error-model-load-failed":
          return [test.testId, this.modelLoadFailed.bind(this)];
        case "error-delete-cache-invalid-params":
          return [test.testId, this.deleteCacheInvalidParams.bind(this)];
        case "error-structured-error-code":
          return [test.testId, this.structuredErrorCode.bind(this)];
        case "error-chaining-cause":
          return [test.testId, this.chainingCause.bind(this)];
        case "error-rag-operation-failed":
          return [test.testId, this.ragOperationFailed.bind(this)];
        case "error-transcription-failed":
          return [test.testId, this.transcriptionFailed.bind(this)];
        case "error-use-unloaded-model":
          return [test.testId, this.useUnloadedModel.bind(this)];
        case "error-rag-unloaded-model":
          return [test.testId, this.ragUnloadedModel.bind(this)];
        case "error-embedding-empty-input":
          return [test.testId, this.embeddingEmptyInput.bind(this)];
        default:
          return [test.testId, this.completionError.bind(this)];
      }
    }),
  ) as never;

  async invalidModelId(params: InvalidModelIdParams): Promise<TestResult> {
    try {
      await embed({ modelId: params.modelId, text: "test text" });
      return { passed: false, output: "Expected error for invalid model ID" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async invalidResponseType(
    _params: VerifyErrorCodesParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    const code = SDK_CLIENT_ERROR_CODES?.INVALID_RESPONSE_TYPE;
    if (code) {
      return ValidationHelpers.validate(
        `SDK_CLIENT_ERROR_CODES.INVALID_RESPONSE_TYPE = ${code}`,
        expectation,
      );
    }
    return ValidationHelpers.validate("SDK error codes not available", expectation);
  }

  async modelLoadFailed(params: ModelLoadFailedParams): Promise<TestResult> {
    try {
      await loadModel({ modelSrc: params.modelPath, modelType: params.modelType as "llamacpp-completion" });
      return { passed: false, output: "Expected error for invalid model path" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async deleteCacheInvalidParams(): Promise<TestResult> {
    try {
      await deleteCache({} as never);
      return { passed: false, output: "Expected error for invalid deleteCache params" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async structuredErrorCode(
    _params: VerifyErrorCodesParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    const clientCount = SDK_CLIENT_ERROR_CODES ? Object.keys(SDK_CLIENT_ERROR_CODES).length : 0;
    const serverCount = SDK_SERVER_ERROR_CODES ? Object.keys(SDK_SERVER_ERROR_CODES).length : 0;
    return ValidationHelpers.validate(
      `Error codes: client=${clientCount}, server=${serverCount}`,
      expectation,
    );
  }

  async chainingCause(): Promise<TestResult> {
    try {
      await loadModel({ modelSrc: "/invalid/nonexistent/path/model.gguf", modelType: "llamacpp-completion" });
      return { passed: false, output: "Expected error" };
    } catch (error) {
      const e = error as Error & { cause?: unknown; code?: number };
      const hasCause = e.cause !== undefined;
      const isStructured = typeof e.code === "number";
      return { passed: hasCause || isStructured, output: `hasCause=${hasCause}, structured=${isStructured}` };
    }
  }

  async ragOperationFailed(params: RagOperationFailedParams): Promise<TestResult> {
    try {
      await ragIngest({ modelId: params.modelId, documents: "test content" as never, workspace: "test" });
      return { passed: false, output: "Expected error for invalid RAG operation" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async transcriptionFailed(params: TranscriptionFailedParams): Promise<TestResult> {
    const whisperModelId = await this.resources.ensureLoaded("whisper");
    try {
      await transcribe({ modelId: whisperModelId, audioChunk: params.audioPath });
      return { passed: false, output: "Expected error for invalid audio path" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async completionError(
    params: CompletionErrorParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded("llm");

    try {
      const result = completion({
        modelId: llmModelId,
        history: params.history,
        stream: params.stream ?? false,
        ...(params.generationParams ? { generationParams: params.generationParams } : {}),
      });
      const text = params.stream
        ? await (async () => { let t = ""; for await (const tok of result.tokenStream) t += tok; return t; })()
        : await result.text;
      return ValidationHelpers.validate(text, expectation);
    } catch (error) {
      if (expectation.validation === "throws-error") {
        return { passed: true, output: `Correctly threw: ${error}` };
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Error: ${errorMsg}` };
    }
  }

  async useUnloadedModel(params: UseUnloadedModelParams): Promise<TestResult> {
    try {
      const result = completion({ modelId: params.modelIdOverride, history: params.history, stream: params.stream });
      await result.text;
      return { passed: false, output: "Expected error for unloaded model" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }

  async embeddingEmptyInput(
    params: EmbeddingEmptyInputParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    const embeddingModelId = await this.resources.ensureLoaded("embeddings");
    try {
      const { embedding: result } = await embed({ modelId: embeddingModelId, text: params.text });
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      return { passed: true, output: `SDK correctly rejected empty input: ${error}` };
    }
  }

  async ragUnloadedModel(params: RagUnloadedModelParams): Promise<TestResult> {
    try {
      await ragIngest({ modelId: params.modelIdOverride, documents: "test" as never, workspace: "test" });
      return { passed: false, output: "Expected error for unloaded embedding model" };
    } catch (error) {
      return { passed: true, output: `Correctly threw: ${error}` };
    }
  }
}
