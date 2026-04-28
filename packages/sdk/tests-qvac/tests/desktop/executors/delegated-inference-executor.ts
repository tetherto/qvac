import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadModel,
  unloadModel,
  completion,
  getLoadedModelInfo,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";
import type { TestResult } from "@tetherto/qvac-test-suite";
import { DelegatedInferenceExecutor as SharedDelegatedInferenceExecutor } from "../../shared/executors/delegated-inference-executor.js";
import {
  delegatedE2ECompletion,
  delegatedE2EStreaming,
  delegatedE2ELoadedModelInfo,
} from "../../delegated-inference-tests.js";
import { generateTopic } from "../../utils/random.js";

const E2E_DELEGATION_TIMEOUT = 60_000;
const E2E_PROVIDER_STARTUP_TIMEOUT = 60_000;

const providerScriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "utils",
  "delegated-provider-process.js",
);

export class DelegatedInferenceExecutor extends SharedDelegatedInferenceExecutor {
  protected override buildHandlers() {
    return {
      ...super.buildHandlers(),
      [delegatedE2ECompletion.testId]: this.e2eCompletion.bind(this),
      [delegatedE2EStreaming.testId]: this.e2eStreaming.bind(this),
      [delegatedE2ELoadedModelInfo.testId]: this.e2eLoadedModelInfo.bind(this),
    };
  }

  private spawnProvider(topic: string): Promise<{ publicKey: string; process: ChildProcess }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [providerScriptPath, topic], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Provider startup timeout after ${E2E_PROVIDER_STARTUP_TIMEOUT}ms`));
      }, E2E_PROVIDER_STARTUP_TIMEOUT);

      let buf = "";
      child.stdout!.on("data", (data: Buffer) => {
        buf += data.toString();
        for (const line of buf.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.ready && msg.publicKey) {
              clearTimeout(timeout);
              resolve({ publicKey: msg.publicKey, process: child });
              return;
            }
          } catch {}
        }
      });

      let stderr = "";
      child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
      child.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
      child.on("exit", (code: number | null) => {
        clearTimeout(timeout);
        reject(new Error(`Provider exited with code ${code}: ${stderr.substring(0, 200)}`));
      });
    });
  }

  private async withRemoteProvider<T>(
    fn: (ctx: { topic: string; publicKey: string }) => Promise<T>,
  ): Promise<T> {
    const topic = generateTopic();
    const provider = await this.spawnProvider(topic);
    try {
      return await fn({ topic, publicKey: provider.publicKey });
    } finally {
      provider.process.kill("SIGTERM");
    }
  }

  private async withDelegatedCompletion(
    history: Array<{ role: string; content: string }>,
    stream: boolean,
  ): Promise<TestResult> {
    return this.withRemoteProvider(async ({ topic, publicKey }) => {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: { topic, providerPublicKey: publicKey, timeout: E2E_DELEGATION_TIMEOUT, fallbackToLocal: false },
      });
      try {
        const result = completion({ modelId, history, stream });
        if (!stream) {
          const text = await result.text;
          if (!text || typeof text !== "string") {
            return { passed: false, output: `Empty or invalid delegated completion: ${text}` };
          }
          return { passed: true, output: `E2E delegated completion: "${text.substring(0, 80)}"` };
        }
        let fullText = "";
        let tokenCount = 0;
        for await (const token of result.tokenStream) {
          fullText += token;
          tokenCount++;
        }
        if (!fullText) {
          return { passed: false, output: "E2E streaming produced no tokens" };
        }
        return { passed: true, output: `E2E delegated streaming (${tokenCount} tokens): "${fullText.substring(0, 80)}"` };
      } finally {
        try { await unloadModel({ modelId }); } catch {}
      }
    });
  }

  async e2eCompletion(params: typeof delegatedE2ECompletion.params): Promise<TestResult> {
    return this.withDelegatedCompletion(params.history as Array<{ role: string; content: string }>, false);
  }

  async e2eStreaming(params: typeof delegatedE2EStreaming.params): Promise<TestResult> {
    return this.withDelegatedCompletion(params.history as Array<{ role: string; content: string }>, true);
  }

  async e2eLoadedModelInfo(): Promise<TestResult> {
    return this.withRemoteProvider(async ({ topic, publicKey }) => {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: { topic, providerPublicKey: publicKey, timeout: E2E_DELEGATION_TIMEOUT, fallbackToLocal: false },
      });
      try {
        const info = await getLoadedModelInfo({ modelId });

        if (!info.isDelegated) {
          return {
            passed: false,
            output: `Expected isDelegated=true for delegated model, got isDelegated=false (modelType=${info.modelType})`,
          };
        }

        const checks = {
          modelIdMatches: info.modelId === modelId,
          handlersIsEmptyArray: Array.isArray(info.handlers) && info.handlers.length === 0,
          providerInfoTopicMatches: info.providerInfo.topic === topic,
          providerInfoPublicKeyMatches: info.providerInfo.providerPublicKey === publicKey,
        };

        const allOk = Object.values(checks).every(Boolean);
        const summary = `modelId=${info.modelId.substring(0, 8)}…, isDelegated=true, handlers=[], providerInfo.topic=${info.providerInfo.topic.substring(0, 8)}…, checks=${JSON.stringify(checks)}`;

        if (!allOk) {
          return { passed: false, output: `Delegated info mismatch: ${summary}` };
        }
        return { passed: true, output: `E2E delegated getLoadedModelInfo OK: ${summary}` };
      } finally {
        try { await unloadModel({ modelId }); } catch {}
      }
    });
  }
}
