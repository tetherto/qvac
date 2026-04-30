import { loggingStream, completion, embed, unloadModel, SDK_LOG_ID } from "@qvac/sdk";
import { type TestResult } from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { loggingTests } from "../../logging-tests.js";

type LogEntry = { timestamp: number; level: string; namespace: string; message: string };

// Wait out the documented "run while previous job is settling" busy throw
// from qvac-lib-infer-llamacpp-llm.
const ADDON_BUSY_MARKER = "a job is already set or being processed";

class AddonBusyTimeoutError extends Error {
  constructor(timeoutMs: number, cause: unknown) {
    super(`Addon stayed busy: waited ${timeoutMs}ms`, { cause });
    this.name = "AddonBusyTimeoutError";
  }
}

async function callWhenAddonIdle<T>(fn: () => Promise<T>, timeoutMs = 30_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(ADDON_BUSY_MARKER)) {
        if (Date.now() >= deadline) throw new AddonBusyTimeoutError(timeoutMs, err);
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      throw err;
    }
  }
}

export class LoggingExecutor extends AbstractModelExecutor<typeof loggingTests> {
  pattern = /^(addon-logging-|logging-)/;

  protected handlers = Object.fromEntries(
    loggingTests.map((test) => {
      if (test.testId === "addon-logging-invalid-model-id") return [test.testId, this.invalidModelId.bind(this)];
      if (test.testId === "addon-logging-during-inference") return [test.testId, this.duringInference.bind(this)];
      if (test.testId.startsWith("addon-logging-")) return [test.testId, this.makeAddonStream(test.testId)];
      if (test.testId === "logging-concurrent-operations") return [test.testId, this.concurrentOperations.bind(this)];
      if (test.testId === "logging-persist-across-reload") return [test.testId, this.persistAcrossReload.bind(this)];
      return [test.testId, this.loggingDuringInference.bind(this)];
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
    return async (): Promise<TestResult> => {
      let targetId: string;
      if (modelType === "sdk") {
        targetId = SDK_LOG_ID ?? "__sdk__";
      } else {
        const dep = modelType === "embeddings" ? "embeddings" : modelType;
        targetId = await this.resources.ensureLoaded(dep);
      }

      const logs: LogEntry[] = [];
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
            await callWhenAddonIdle(async () => {
              const r = completion({ modelId: targetId, history: [{ role: "user", content: "Hi" }], stream: false });
              await r.text;
            });
          } else if (modelType === "embeddings") {
            await embed({ modelId: targetId, text: "test" });
          }
        })();

        await Promise.race([collectPromise, triggerPromise.then(() => new Promise((r) => setTimeout(r, 5000)))]);

        return {
          passed: logs.length > 0,
          output: logs.length > 0
            ? `Received ${logs.length} log(s) from ${modelType}`
            : `No logs received from ${modelType} within timeout`,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `Addon logging error: ${errorMsg}` };
      }
    };
  }

  async invalidModelId(params: unknown): Promise<TestResult> {
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

      return {
        passed: receivedLogs === 0,
        output: receivedLogs === 0
          ? "Invalid model ID produced no logs"
          : `Unexpectedly received ${receivedLogs} log(s)`,
      };
    } catch (error) {
      return { passed: true, output: `Invalid model ID correctly rejected: ${error}` };
    }
  }

  async duringInference(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");
    const logs: LogEntry[] = [];

    try {
      const logPromise = (async () => {
        for await (const log of loggingStream({ id: modelId })) {
          logs.push(log);
          if (logs.length >= 5) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 200));

      await callWhenAddonIdle(async () => {
        const result = completion({
          modelId,
          history: [{ role: "user", content: "Say hello in one word." }],
          stream: true,
        });
        for await (const _token of result.tokenStream) { /* drain */ }
      });

      await Promise.race([logPromise, new Promise((r) => setTimeout(r, 1000))]);

      return {
        passed: logs.length > 0,
        output: logs.length > 0
          ? `Received ${logs.length} log(s) during streaming inference`
          : "No logs received during inference",
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Inference logging error: ${errorMsg}` };
    }
  }

  async concurrentOperations(params: unknown): Promise<TestResult> {
    const p = params as { operations: string[]; runConcurrently: boolean };
    const llmModelId = await this.resources.ensureLoaded("llm");

    const logs: LogEntry[] = [];
    try {
      const collectPromise = (async () => {
        for await (const log of loggingStream({ id: llmModelId })) {
          logs.push(log);
          if (logs.length >= 5) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 100));

      const operations: Promise<unknown>[] = [];
      if (p.operations.includes("completion")) {
        operations.push(callWhenAddonIdle(async () => {
          const r = completion({ modelId: llmModelId, history: [{ role: "user", content: "Test concurrent logging" }], stream: false });
          await r.text;
        }));
      }
      if (p.operations.includes("embedding")) {
        const embeddingModelId = await this.resources.ensureLoaded("embeddings");
        operations.push(embed({ modelId: embeddingModelId, text: "test concurrent" }));
      }

      await Promise.allSettled(operations);
      await Promise.race([collectPromise, new Promise((r) => setTimeout(r, 3000))]);

      return {
        passed: logs.length > 0,
        output: logs.length > 0
          ? `${p.operations.length} concurrent operations produced ${logs.length} log(s)`
          : `No logs received from ${p.operations.length} concurrent operations`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Concurrent logging error: ${errorMsg}` };
    }
  }

  async persistAcrossReload(): Promise<TestResult> {
    try {
      const originalModelId = this.resources.getModelId("llm");
      if (originalModelId) {
        await unloadModel({ modelId: originalModelId });
        this.resources.unregister(originalModelId);
      }

      const reloadedModelId = await this.resources.ensureLoaded("llm");

      const logs: LogEntry[] = [];
      const collectPromise = (async () => {
        for await (const log of loggingStream({ id: reloadedModelId })) {
          logs.push(log);
          if (logs.length >= 1) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 100));

      await callWhenAddonIdle(async () => {
        const r = completion({ modelId: reloadedModelId, history: [{ role: "user", content: "Post-reload test" }], stream: false });
        await r.text;
      });

      await Promise.race([collectPromise, new Promise((r) => setTimeout(r, 5000))]);

      return {
        passed: logs.length > 0,
        output: logs.length > 0
          ? `Logging works after reload (${logs.length} log(s) received)`
          : "No logs received after model reload",
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Persist across reload error: ${errorMsg}` };
    }
  }

  async loggingDuringInference(params: unknown): Promise<TestResult> {
    const p = params as { operationCount?: number; verifyTimestamps?: boolean };
    const modelId = await this.resources.ensureLoaded("llm");
    const operationCount = p.operationCount || 1;

    const logs: LogEntry[] = [];
    try {
      const collectPromise = (async () => {
        for await (const log of loggingStream({ id: modelId })) {
          logs.push(log);
          if (logs.length >= operationCount * 5) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 100));

      for (let i = 0; i < operationCount; i++) {
        await callWhenAddonIdle(async () => {
          const r = completion({ modelId, history: [{ role: "user", content: `Logging test ${i + 1}` }], stream: false });
          await r.text;
        });
      }

      await Promise.race([collectPromise, new Promise((r) => setTimeout(r, 5000))]);

      if (p.verifyTimestamps) {
        if (logs.length < 2) {
          return { passed: false, output: `Need >= 2 logs to verify timestamps, got ${logs.length}` };
        }
        const outOfOrder = logs.some((log, i) => i > 0 && log.timestamp < logs[i - 1].timestamp);
        return {
          passed: !outOfOrder,
          output: outOfOrder
            ? `Timestamps out of order in ${logs.length} logs`
            : `Timestamps monotonic across ${logs.length} logs`,
        };
      }

      return {
        passed: logs.length > 0,
        output: logs.length > 0
          ? `${operationCount} operation(s) produced ${logs.length} log(s)`
          : `No logs received from ${operationCount} operation(s)`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Logging during inference error: ${errorMsg}` };
    }
  }
}
