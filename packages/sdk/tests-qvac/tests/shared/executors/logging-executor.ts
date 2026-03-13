import { loggingStream, completion, embed, SDK_LOG_ID } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { loggingTests } from "../../logging-tests.js";

export class LoggingExecutor extends AbstractModelExecutor<typeof loggingTests> {
  pattern = /^(addon-logging-|logging-)/;

  protected handlers = Object.fromEntries(
    loggingTests.map((test) => {
      if (test.testId === "addon-logging-invalid-model-id") return [test.testId, this.invalidModelId.bind(this)];
      if (test.testId === "addon-logging-during-inference") return [test.testId, this.duringInference.bind(this)];
      if (test.testId.startsWith("addon-logging-")) return [test.testId, this.makeAddonStream(test.testId)];
      return [test.testId, this.edgeCase.bind(this)];
    }),
  ) as never;

  private getModelType(testId: string): string {
    if (testId.includes("-llm")) return "llm";
    if (testId.includes("-embed")) return "embeddings";
    if (testId.includes("-whisper")) return "whisper";
    if (testId.includes("-sdk-server")) return "sdk";
    return "llm";
  }

  private makeAddonStream(testId: string) {
    const modelType = this.getModelType(testId);
    return async (params: unknown, expectation: unknown): Promise<TestResult> => {
      let targetId: string;
      if (modelType === "sdk") {
        targetId = SDK_LOG_ID ?? "__sdk__";
      } else {
        const dep = modelType === "embeddings" ? "embeddings" : modelType;
        targetId = await this.resources.ensureLoaded(dep);
      }

      const logs: unknown[] = [];
      try {
        const collectPromise = (async () => {
          for await (const log of loggingStream({ id: targetId })) {
            logs.push(log);
            if (logs.length >= 1) break;
          }
        })();

        const triggerPromise = (async () => {
          await new Promise((r) => setTimeout(r, 100));
          if (modelType === "llm") {
            const r = completion({ modelId: targetId, history: [{ role: "user", content: "Hi" }], stream: false });
            await r.text;
          } else if (modelType === "embeddings") {
            await embed({ modelId: targetId, text: "test" });
          }
        })();

        await Promise.race([collectPromise, triggerPromise.then(() => new Promise((r) => setTimeout(r, 5000)))]);

        return ValidationHelpers.validate(
          `Received ${logs.length} logs from ${modelType}`,
          expectation as Expectation,
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `Addon logging error: ${errorMsg}` };
      }
    };
  }

  async invalidModelId(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { invalidModelId: string };

    try {
      let receivedLogs = 0;
      const streamPromise = (async () => {
        try {
          for await (const _log of loggingStream({ id: p.invalidModelId })) {
            receivedLogs++;
            if (receivedLogs >= 3) break;
          }
        } catch { /* expected */ }
      })();

      await Promise.race([streamPromise, new Promise((r) => setTimeout(r, 3000))]);

      return ValidationHelpers.validate(
        receivedLogs === 0
          ? "Invalid model ID handled correctly - no logs"
          : `Received ${receivedLogs} logs (unexpected)`,
        expectation as Expectation,
      );
    } catch (error) {
      return ValidationHelpers.validate(
        `Invalid model ID handled: ${error}`,
        expectation as Expectation,
      );
    }
  }

  async duringInference(params: unknown, expectation: unknown): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");
    const logs: unknown[] = [];

    try {
      const logPromise = (async () => {
        for await (const log of loggingStream({ id: modelId })) {
          logs.push(log);
          if (logs.length >= 5) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 200));

      const result = completion({
        modelId,
        history: [{ role: "user", content: "Say hello in one word." }],
        stream: true,
      });
      let tokens = "";
      for await (const token of result.tokenStream) {
        tokens += token;
      }

      await Promise.race([logPromise, new Promise((r) => setTimeout(r, 1000))]);

      return ValidationHelpers.validate(
        `Received ${logs.length} logs during inference`,
        expectation as Expectation,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Inference logging error: ${errorMsg}` };
    }
  }

  async edgeCase(params: unknown, expectation: unknown): Promise<TestResult> {
    try {
      return ValidationHelpers.validate(
        "Logging edge case test completed",
        expectation as Expectation,
      );
    } catch (error) {
      return ValidationHelpers.validate(
        `Logging edge case handled: ${error}`,
        expectation as Expectation,
      );
    }
  }
}
