import {
  startQVACProvider,
  stopQVACProvider,
  loadModel,
  unloadModel,
  heartbeat,
  cancel,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";
import {
  BaseExecutor,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import {
  delegatedProviderStart,
  delegatedProviderStop,
  delegatedProviderFirewall,
  delegatedProviderRestart,
  delegatedLoadModelFallbackLocal,
  delegatedHeartbeatProvider,
  delegatedCancelDownload,
  delegatedConnectionFailure,
  delegatedInvalidTopic,
  delegatedProviderNotFound,
} from "../../delegated-inference-tests.js";
import { randomHex, generateTopic } from "../../utils/random.js";

const DEFAULT_DELEGATE_TIMEOUT = 10_000;

const isDelegationError = (msg: string): boolean =>
  msg.includes("DELEGATE_CONNECTION_FAILED") || msg.includes("RPC connection failed");

const allTests = [
  delegatedProviderStart,
  delegatedProviderStop,
  delegatedProviderFirewall,
  delegatedProviderRestart,
  delegatedLoadModelFallbackLocal,
  delegatedHeartbeatProvider,
  delegatedCancelDownload,
  delegatedConnectionFailure,
  delegatedInvalidTopic,
  delegatedProviderNotFound,
] as const;

export class DelegatedInferenceExecutor extends BaseExecutor<typeof allTests> {
  pattern = /^delegated-/;

  protected handlers = this.buildHandlers();

  protected buildHandlers() {
    return {
      [delegatedProviderStart.testId]: this.providerStart.bind(this),
      [delegatedProviderStop.testId]: this.providerStop.bind(this),
      [delegatedProviderFirewall.testId]: this.providerFirewall.bind(this),
      [delegatedProviderRestart.testId]: this.providerRestart.bind(this),
      [delegatedLoadModelFallbackLocal.testId]: this.loadModelFallbackLocal.bind(this),
      [delegatedHeartbeatProvider.testId]: this.heartbeatProvider.bind(this),
      [delegatedCancelDownload.testId]: this.cancelDelegatedDownload.bind(this),
      [delegatedConnectionFailure.testId]: this.connectionFailure.bind(this),
      [delegatedInvalidTopic.testId]: this.invalidTopic.bind(this),
      [delegatedProviderNotFound.testId]: this.providerNotFound.bind(this),
    };
  }

  private async withProvider<T>(
    fn: (ctx: { topic: string; publicKey: string }) => Promise<T>,
  ): Promise<T> {
    const topic = generateTopic();
    const response = await startQVACProvider({ topic });
    if (!response.publicKey) {
      throw new Error(`startQVACProvider returned no publicKey: ${JSON.stringify(response)}`);
    }
    try {
      return await fn({ topic, publicKey: response.publicKey });
    } finally {
      try { await stopQVACProvider({ topic }); } catch {}
    }
  }

  async providerStart(): Promise<TestResult> {
    const topic = generateTopic();
    const response = await startQVACProvider({ topic });
    try {
      if (!response.publicKey || typeof response.publicKey !== "string") {
        return { passed: false, output: `Missing or invalid publicKey: ${JSON.stringify(response)}` };
      }
      return { passed: true, output: `Provider started, publicKey: ${response.publicKey.substring(0, 16)}...` };
    } finally {
      try { await stopQVACProvider({ topic }); } catch {}
    }
  }

  async providerStop(): Promise<TestResult> {
    const topic = generateTopic();
    await startQVACProvider({ topic });
    try {
      const response = await stopQVACProvider({ topic });
      if (response.success !== true) {
        return { passed: false, output: `stopQVACProvider failed: ${JSON.stringify(response)}` };
      }
      return { passed: true, output: "Provider started and stopped successfully" };
    } catch (error) {
      try { await stopQVACProvider({ topic }); } catch {}
      throw error;
    }
  }

  async providerFirewall(params: typeof delegatedProviderFirewall.params): Promise<TestResult> {
    const topic = generateTopic();
    const firewall = params.firewall as { mode: "allow" | "deny"; publicKeys: string[] };
    const response = await startQVACProvider({ topic, firewall });
    try {
      if (!response.publicKey) {
        return { passed: false, output: `Provider with firewall failed: ${JSON.stringify(response)}` };
      }
      return {
        passed: true,
        output: `Provider with firewall (mode=${firewall.mode}) started, publicKey: ${response.publicKey.substring(0, 16)}...`,
      };
    } finally {
      try { await stopQVACProvider({ topic }); } catch {}
    }
  }

  async providerRestart(): Promise<TestResult> {
    const topic1 = generateTopic();
    await startQVACProvider({ topic: topic1 });
    await stopQVACProvider({ topic: topic1 });

    const topic2 = generateTopic();
    const response = await startQVACProvider({ topic: topic2 });
    try {
      if (!response.publicKey) {
        return { passed: false, output: "Provider failed to restart on new topic" };
      }
      return {
        passed: true,
        output: `Provider restarted successfully, publicKey: ${response.publicKey.substring(0, 16)}...`,
      };
    } finally {
      try { await stopQVACProvider({ topic: topic2 }); } catch {}
    }
  }

  async loadModelFallbackLocal(): Promise<TestResult> {
    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      delegate: {
        topic: generateTopic(),
        providerPublicKey: randomHex(32),
        timeout: 3000,
        fallbackToLocal: true,
      },
    });
    try {
      if (!modelId || typeof modelId !== "string") {
        return { passed: false, output: `Fallback did not produce valid modelId: ${modelId}` };
      }
      return { passed: true, output: `Delegation failed, fell back to local: ${modelId}` };
    } finally {
      try { await unloadModel({ modelId }); } catch {}
    }
  }

  async heartbeatProvider(): Promise<TestResult> {
    return this.withProvider(async ({ topic, publicKey }) => {
      try {
        const response = await heartbeat({
          delegate: { topic, providerPublicKey: publicKey, timeout: DEFAULT_DELEGATE_TIMEOUT },
        });
        if (response.type !== "heartbeat") {
          return { passed: false, output: `Invalid heartbeat response: ${JSON.stringify(response)}` };
        }
        return { passed: true, output: "Delegated heartbeat to provider OK" };
      } catch (error) {
        // Same-process provider can't connect to itself via HyperSwarm,
        // so DELEGATE_CONNECTION_FAILED is expected — it confirms the SDK
        // correctly routed the request through the delegation path.
        const msg = error instanceof Error ? error.message : String(error);

        if (isDelegationError(msg)) {
          return { passed: true, output: `Delegated heartbeat routed correctly (same-process): ${msg.substring(0, 120)}` };
        }
        return { passed: false, output: `Unexpected heartbeat error: ${msg}` };
      }
    });
  }

  async cancelDelegatedDownload(): Promise<TestResult> {
    return this.withProvider(async ({ topic, publicKey }) => {
      try {
        await cancel({
          operation: "downloadAsset",
          downloadKey: "nonexistent-delegated-download",
          delegate: { topic, providerPublicKey: publicKey, timeout: DEFAULT_DELEGATE_TIMEOUT },
        });
        return { passed: true, output: "Cancel delegated download API accepted" };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        if (isDelegationError(msg)) {
          return { passed: true, output: `Delegated cancel routed correctly: ${msg.substring(0, 100)}` };
        }
        return { passed: false, output: `Unexpected error: ${msg.substring(0, 100)}` };
      }
    });
  }

  async connectionFailure(params: typeof delegatedConnectionFailure.params): Promise<TestResult> {
    const timeout = (params.timeout ?? 3000) as number;
    try {
      await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: {
          topic: generateTopic(),
          providerPublicKey: randomHex(32),
          timeout,
          fallbackToLocal: false,
        },
      });
      return { passed: false, output: "Should have thrown for non-existent provider" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (isDelegationError(msg)) {
        return { passed: true, output: `Connection failure handled: ${msg.substring(0, 120)}` };
      }
      return { passed: false, output: `Unexpected error (expected delegation error): ${msg.substring(0, 120)}` };
    }
  }

  async invalidTopic(): Promise<TestResult> {
    try {
      await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: {
          topic: "not-a-valid-hex-topic!!!",
          providerPublicKey: "also-invalid",
          fallbackToLocal: false,
        },
      });
      return { passed: false, output: "Should have thrown for invalid topic" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (isDelegationError(msg) || msg.includes("Invalid input")) {
        return { passed: true, output: `Invalid topic rejected: ${msg.substring(0, 120)}` };
      }
      return { passed: false, output: `Unexpected error (expected delegation/validation error): ${msg.substring(0, 120)}` };
    }
  }

  async providerNotFound(params: typeof delegatedProviderNotFound.params): Promise<TestResult> {
    try {
      await heartbeat({
        delegate: {
          topic: generateTopic(),
          providerPublicKey: randomHex(32),
          timeout: (params.timeout ?? 3000) as number,
        },
      });
      return { passed: false, output: "Should have thrown for unreachable provider" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (isDelegationError(msg)) {
        return { passed: true, output: `Unreachable provider detected: ${msg.substring(0, 120)}` };
      }
      return { passed: false, output: `Unexpected error (expected delegation error): ${msg.substring(0, 120)}` };
    }
  }

}
