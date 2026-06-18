import {
  loggingStream,
  completion,
  embed,
  textToSpeech,
  translate,
  diffusion,
  unloadModel,
  SDK_LOG_ID,
} from "@qvac/sdk";
import { type TestResult } from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { loggingTests } from "../../logging-tests.js";
import { callWhenAddonIdle } from "../utils/addon-idle.js";

// Mirror of `LoggingStreamResponse` from @qvac/sdk (not currently exported).
export interface LogEntry {
  timestamp: number;
  level: string;
  namespace: string;
  message: string;
}

interface AudioParams { audioFileName: string }
interface ImageParams { imageFileName: string }
interface InvalidModelIdParams { invalidModelId: string }
interface OperationsParams { operations: ReadonlyArray<string> }
interface DuringInferenceParams {
  operationCount?: number;
  streaming?: boolean;
  verifyTimestamps?: boolean;
}

type AnyParams = Record<string, unknown>;

const STREAM_OPEN_DELAY_MS = 100;
const POST_TRIGGER_GRACE_MS = 5_000;
const INVALID_ID_TIMEOUT_MS = 3_000;
const DURING_INFERENCE_DRAIN_MS = 1_000;
const CONCURRENT_DRAIN_MS = 3_000;
const RELOAD_DRAIN_MS = 5_000;
// Bounded wait for a trigger to wind down so the next test doesn't inherit an in-flight job.
const TRIGGER_JOIN_GRACE_MS = 8_000;
// Cap completion length — logging tests only need log flow, not a full response.
const LOGGING_TRIGGER_PREDICT_TOKENS = 20;

const TRIGGER_KEYS = [
  "llm", "embed", "tts", "nmt", "diffusion",
  "whisper", "parakeet", "ocr",
] as const;

type TriggerKey = typeof TRIGGER_KEYS[number];
type Trigger = (modelId: string, params: AnyParams) => Promise<void>;

const isTriggerKey = makeKeyGuard(TRIGGER_KEYS);

const HANDLER_KEYS = [
  "addon-logging",
  "invalid-model-id",
  "during-inference",
  "concurrent",
  "reload",
] as const;

type HandlerKey = typeof HANDLER_KEYS[number];

const isHandlerKey = makeKeyGuard(HANDLER_KEYS);

const TESTS_BY_ID = new Map(loggingTests.map((t) => [t.testId, t]));

function getMeta(testId: string): Record<string, unknown> {
  return (TESTS_BY_ID.get(testId)?.metadata ?? {}) as Record<string, unknown>;
}

function getRequiredMeta(testId: string, key: string): string {
  const value = getMeta(testId)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Test "${testId}" missing required metadata.${key}`);
  }
  return value;
}

export class LoggingExecutor extends AbstractModelExecutor<typeof loggingTests> {
  pattern = /^(addon-logging-|logging-)/;

  protected handlers = Object.fromEntries(
    loggingTests.map((test) => [
      test.testId,
      (params: AnyParams) => this.dispatch(test.testId, params),
    ]),
  ) as never;

  private readonly triggers: Readonly<Record<TriggerKey, Trigger>> = Object.freeze({
    llm:       (id) => this.triggerLlm(id),
    embed:     (id) => this.triggerEmbed(id),
    tts:       (id) => this.triggerTts(id),
    nmt:       (id) => this.triggerNmt(id),
    diffusion: (id) => this.triggerDiffusion(id),
    whisper:   (id, p) => this.triggerWhisper(id, requireAudioParams(p)),
    parakeet:  (id, p) => this.triggerParakeet(id, requireAudioParams(p)),
    ocr:       (id, p) => this.triggerOcr(id, requireImageParams(p)),
  });

  private async dispatch(testId: string, params: AnyParams): Promise<TestResult> {
    const handler = params["handler"];

    if (!isHandlerKey(handler)) {
      throw new Error(`Test "${testId}" has missing/invalid params.handler: ${String(handler)}`);
    }

    let result: TestResult;
    try {
      result = await this.runHandler(handler, testId, params);
    } catch (error) {
      result = wrapError(testId, error);
    }

    // Break the busy cascade: evict the dep on any failure so the next test reloads a fresh model.
    if (!result.passed) {
      await this.evictTestDeps(testId);
    }
    return result;
  }

  private runHandler(handler: HandlerKey, testId: string, params: AnyParams): Promise<TestResult> {
    switch (handler) {
      case "addon-logging":     return this.runAddonLogging(testId, params);
      case "invalid-model-id":  return this.runInvalidModelId(requireInvalidModelIdParams(params));
      case "during-inference":  return this.runDuringInference(testId, params as DuringInferenceParams);
      case "concurrent":        return this.runConcurrent(testId, requireOperationsParams(params));
      case "reload":            return this.runReload(testId);
    }
  }

  private async evictTestDeps(testId: string): Promise<void> {
    const dep = getMeta(testId)["dependency"];
    if (typeof dep !== "string" || dep.length === 0 || dep === "none") return;
    try {
      await this.resources.evict(dep);
    } catch (error) {
      console.warn(`LoggingExecutor: failed to evict dep "${dep}" after failure: ${error}`);
    }
  }

  private async runAddonLogging(testId: string, params: AnyParams): Promise<TestResult> {
    // SDK-server logs flow with any RPC; no explicit trigger needed.
    if (getMeta(testId)["target"] === "sdk-server") {
      return collectLogs({ testId, targetId: SDK_LOG_ID, target: 1, postTriggerWaitMs: POST_TRIGGER_GRACE_MS });
    }

    const dep = getRequiredMeta(testId, "dependency");
    const triggerKey = params["trigger"];
    if (!isTriggerKey(triggerKey)) {
      throw new Error(`addon-logging test "${testId}" has invalid params.trigger: ${String(triggerKey)}`);
    }

    const targetId = await this.resources.ensureLoaded(dep);
    return collectLogs({
      testId,
      targetId,
      target: 1,
      trigger: () => this.triggers[triggerKey](targetId, params),
      postTriggerWaitMs: POST_TRIGGER_GRACE_MS,
    });
  }

  private async runInvalidModelId(params: InvalidModelIdParams): Promise<TestResult> {
    let receivedLogs = 0;
    const streamPromise = (async () => {
      try {
        for await (const _log of loggingStream({ id: params.invalidModelId })) {
          receivedLogs++;
          if (receivedLogs >= 3) break;
        }
      } catch { /* expected */ }
    })();

    await Promise.race([streamPromise, sleep(INVALID_ID_TIMEOUT_MS)]);

    return {
      passed: receivedLogs === 0,
      output: receivedLogs === 0
        ? "Invalid model ID produced no logs"
        : `Unexpectedly received ${receivedLogs} log(s)`,
    };
  }

  private async runDuringInference(testId: string, params: DuringInferenceParams): Promise<TestResult> {
    const dep = getRequiredMeta(testId, "dependency");
    const targetId = await this.resources.ensureLoaded(dep);
    const operationCount = params.operationCount ?? 1;
    const streaming = params.streaming ?? false;

    const result = await collectLogs({
      testId,
      targetId,
      target: operationCount * 5,
      preTriggerExtraWaitMs: streaming ? STREAM_OPEN_DELAY_MS : 0,
      postTriggerWaitMs: streaming ? DURING_INFERENCE_DRAIN_MS : RELOAD_DRAIN_MS,
      trigger: async () => {
        for (let i = 0; i < operationCount; i++) {
          await callWhenAddonIdle(() => runCompletion(targetId, `Logging test ${i + 1}`, streaming));
        }
      },
    });

    if (params.verifyTimestamps && result.passed) {
      return verifyTimestamps(result);
    }
    return result;
  }

  private async runConcurrent(testId: string, params: OperationsParams): Promise<TestResult> {
    const dep = getRequiredMeta(testId, "dependency");
    const targetId = await this.resources.ensureLoaded(dep);

    return collectLogs({
      testId,
      targetId,
      target: 5,
      postTriggerWaitMs: CONCURRENT_DRAIN_MS,
      trigger: async () => {
        const ops: Promise<void>[] = [];
        if (params.operations.includes("completion")) {
          ops.push(callWhenAddonIdle(() => runCompletion(targetId, "Test concurrent logging", false)));
        }
        if (params.operations.includes("embedding")) {
          const embeddingModelId = await this.resources.ensureLoaded("embeddings");
          ops.push(embed({ modelId: embeddingModelId, text: "test concurrent" }).then(() => undefined));
        }
        await Promise.allSettled(ops);
      },
    });
  }

  private async runReload(testId: string): Promise<TestResult> {
    const dep = getRequiredMeta(testId, "dependency");

    const originalModelId = this.resources.getModelId(dep);
    if (originalModelId) {
      // Keep RPC open during reload to avoid loggingStream race on mobile.
      await unloadModel({ modelId: originalModelId, autoClose: false });
      this.resources.unregister(originalModelId);
    }

    const reloadedModelId = await this.resources.ensureLoaded(dep);

    return collectLogs({
      testId,
      targetId: reloadedModelId,
      target: 1,
      postTriggerWaitMs: RELOAD_DRAIN_MS,
      trigger: () => callWhenAddonIdle(() =>
        runCompletion(reloadedModelId, "Post-reload test", false),
      ),
    });
  }

  protected triggerLlm(modelId: string): Promise<void> {
    return callWhenAddonIdle(() => runCompletion(modelId, "Hi", false));
  }

  protected async triggerEmbed(modelId: string): Promise<void> {
    await embed({ modelId, text: "test" });
  }

  protected async triggerTts(modelId: string): Promise<void> {
    const r = textToSpeech({ modelId, text: "Hi", inputType: "text", stream: false });
    await r.buffer;
  }

  protected async triggerNmt(modelId: string): Promise<void> {
    const r = translate({ modelId, text: "Hello world", modelType: "nmt", stream: false });
    await r.text;
  }

  // steps=1 + small dims; we only need the first log, not the full image.
  protected async triggerDiffusion(modelId: string): Promise<void> {
    const { outputs } = diffusion({
      modelId,
      prompt: "a red square",
      width: 256,
      height: 256,
      steps: 1,
    });
    await outputs;
  }

  // Overridden in DesktopLoggingExecutor / MobileLoggingExecutor.
  protected triggerWhisper(_modelId: string, _params: AudioParams): Promise<void> {
    return notImplemented("triggerWhisper");
  }

  protected triggerParakeet(_modelId: string, _params: AudioParams): Promise<void> {
    return notImplemented("triggerParakeet");
  }

  protected triggerOcr(_modelId: string, _params: ImageParams): Promise<void> {
    return notImplemented("triggerOcr");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CollectLogsOptions {
  testId: string;
  targetId: string;
  target: number;
  trigger?: () => Promise<void>;
  postTriggerWaitMs: number;
  preTriggerExtraWaitMs?: number;
}

interface CollectLogsResult extends TestResult {
  logs: LogEntry[];
}

async function collectLogs(opts: CollectLogsOptions): Promise<CollectLogsResult> {
  const { testId, targetId, target, trigger, postTriggerWaitMs, preTriggerExtraWaitMs = 0 } = opts;
  const logs: LogEntry[] = [];

  // Drop logs emitted before the trigger fires so buffered load logs from a
  // preloaded `metadata.dependency` can't satisfy `target`.
  let triggerStartMs = trigger ? Number.POSITIVE_INFINITY : 0;

  const collectPromise = (async () => {
    for await (const log of loggingStream({ id: targetId })) {
      if (log.timestamp < triggerStartMs) continue;
      logs.push(log);
      if (logs.length >= target) break;
    }
  })();

  const triggerPromise = (async () => {
    await sleep(STREAM_OPEN_DELAY_MS + preTriggerExtraWaitMs);
    if (trigger) {
      triggerStartMs = Date.now();
      await trigger();
    }
  })();

  await Promise.race([
    collectPromise,
    triggerPromise.then(() => sleep(postTriggerWaitMs)),
  ]);

  // Wait for the trigger to finish; if the grace period expires first the
  // addon slot is still occupied — fail so dispatch evicts the dependency.
  let graceFired = false;
  await Promise.race([
    triggerPromise.catch(() => undefined),
    sleep(TRIGGER_JOIN_GRACE_MS).then(() => { graceFired = true; }),
  ]);

  if (graceFired) {
    return {
      logs,
      passed: false,
      output: `Trigger still in-flight after ${TRIGGER_JOIN_GRACE_MS}ms grace period; evicting to prevent cascade`,
    };
  }

  return {
    logs,
    passed: logs.length > 0,
    output: logs.length > 0
      ? `Received ${logs.length} log(s) for ${testId}`
      : `No logs received for ${testId} within timeout`,
  };
}

function verifyTimestamps(result: CollectLogsResult): TestResult {
  const { logs } = result;
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

function wrapError(testId: string, error: unknown): TestResult {
  const msg = error instanceof Error ? error.message : String(error);
  return { passed: false, output: `Logging test error (${testId}): ${msg}` };
}

async function runCompletion(modelId: string, content: string, stream: boolean): Promise<void> {
  const result = completion({
    modelId,
    history: [{ role: "user", content }],
    stream,
    generationParams: { predict: LOGGING_TRIGGER_PREDICT_TOKENS },
  } as never);
  if (stream) {
    for await (const _token of result.tokenStream) { /* drain */ }
    return;
  }
  await result.text;
}

function requireStringField<K extends string>(
  p: AnyParams,
  key: K,
  context: string,
): { [P in K]: string } {
  const value = p[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} expected \`${key}\` (non-empty string) in params`);
  }
  return { [key]: value } as { [P in K]: string };
}

function requireStringArrayField<K extends string>(
  p: AnyParams,
  key: K,
  context: string,
): { [P in K]: string[] } {
  const value = p[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${context} expected \`${key}: string[]\` in params`);
  }
  return { [key]: value as string[] } as { [P in K]: string[] };
}

const requireAudioParams = (p: AnyParams) => requireStringField(p, "audioFileName", "Trigger");
const requireImageParams = (p: AnyParams) => requireStringField(p, "imageFileName", "Trigger");
const requireInvalidModelIdParams = (p: AnyParams) => requireStringField(p, "invalidModelId", "invalid-model-id handler");
const requireOperationsParams = (p: AnyParams) => requireStringArrayField(p, "operations", "concurrent handler");

function makeKeyGuard<T extends string>(keys: ReadonlyArray<T>) {
  const set: ReadonlySet<string> = new Set(keys);
  return (value: unknown): value is T => typeof value === "string" && set.has(value);
}

function notImplemented(name: string): never {
  throw new Error(`${name} must be overridden by the platform LoggingExecutor subclass`);
}
