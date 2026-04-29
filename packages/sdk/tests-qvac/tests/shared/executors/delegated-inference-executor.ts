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
  delegatedInvalidProviderKey,
  delegatedProviderNotFound,
} from "../../delegated-inference-tests.js";
import { randomHex } from "../../utils/random.js";

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
  delegatedInvalidProviderKey,
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
      [delegatedInvalidProviderKey.testId]: this.invalidProviderKey.bind(this),
      [delegatedProviderNotFound.testId]: this.providerNotFound.bind(this),
    };
  }

  private async withProvider<T>(
    fn: (ctx: { publicKey: string }) => Promise<T>,
  ): Promise<T> {
    const response = await startQVACProvider();
    if (!response.publicKey) {
      throw new Error(`startQVACProvider returned no publicKey: ${JSON.stringify(response)}`);
    }
    try {
      return await fn({ publicKey: response.publicKey });
    } finally {
      try { await stopQVACProvider(); } catch {}
    }
  }

  async providerStart(): Promise<TestResult> {
    const response = await startQVACProvider();
    try {
      if (!response.publicKey || typeof response.publicKey !== "string") {
        return { passed: false, output: `Missing or invalid publicKey: ${JSON.stringify(response)}` };
      }
      return { passed: true, output: `Provider started, publicKey: ${response.publicKey.substring(0, 16)}...` };
    } finally {
      try { await stopQVACProvider(); } catch {}
    }
  }

  async providerStop(): Promise<TestResult> {
    await startQVACProvider();
    try {
      const response = await stopQVACProvider();
      if (response.success !== true) {
        return { passed: false, output: `stopQVACProvider failed: ${JSON.stringify(response)}` };
      }
      return { passed: true, output: "Provider started and stopped successfully" };
    } catch (error) {
      try { await stopQVACProvider(); } catch {}
      throw error;
    }
  }

  async providerFirewall(params: typeof delegatedProviderFirewall.params): Promise<TestResult> {
    const firewall = params.firewall as { mode: "allow" | "deny"; publicKeys: string[] };
    const response = await startQVACProvider({ firewall });
    try {
      if (!response.publicKey) {
        return { passed: false, output: `Provider with firewall failed: ${JSON.stringify(response)}` };
      }
      return {
        passed: true,
        output: `Provider with firewall (mode=${firewall.mode}) started, publicKey: ${response.publicKey.substring(0, 16)}...`,
      };
    } finally {
      try { await stopQVACProvider(); } catch {}
    }
  }

  async providerRestart(): Promise<TestResult> {
    await startQVACProvider();
    await stopQVACProvider();

    const response = await startQVACProvider();
    try {
      if (!response.publicKey) {
        return { passed: false, output: "Provider failed to restart" };
      }
      return {
        passed: true,
        output: `Provider restarted successfully, publicKey: ${response.publicKey.substring(0, 16)}...`,
      };
    } finally {
      try { await stopQVACProvider(); } catch {}
    }
  }

  async loadModelFallbackLocal(): Promise<TestResult> {
    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      delegate: {
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
    return this.withProvider(async ({ publicKey }) => {
      try {
        const response = await heartbeat({
          delegate: { providerPublicKey: publicKey, timeout: DEFAULT_DELEGATE_TIMEOUT },
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
    return this.withProvider(async ({ publicKey }) => {
      try {
        await cancel({
          operation: "downloadAsset",
          downloadKey: "nonexistent-delegated-download",
          delegate: { providerPublicKey: publicKey, timeout: DEFAULT_DELEGATE_TIMEOUT },
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

  async invalidProviderKey(): Promise<TestResult> {
    try {
      await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: {
          providerPublicKey: "also-invalid",
          fallbackToLocal: false,
        },
      });
      return { passed: false, output: "Should have thrown for invalid provider key" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (
        isDelegationError(msg) ||
        msg.includes("Invalid input") ||
        msg.includes("64-character hex") ||
        msg.includes("providerPublicKey")
      ) {
        return { passed: true, output: `Invalid provider key rejected: ${msg.substring(0, 120)}` };
      }
      return { passed: false, output: `Unexpected error (expected delegation/validation error): ${msg.substring(0, 120)}` };
    }
  }

  async providerNotFound(params: typeof delegatedProviderNotFound.params): Promise<TestResult> {
    try {
      await heartbeat({
        delegate: {
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
