/**
 * The Pocket engine's execution rules. Pocket runs one native job at a time
 * and reports its end through a terminal callback (stats or error), so each
 * job sits behind a completion barrier that is drained before the next
 * request, and lifecycle operations (load, unload, destroy, reload) refuse to
 * overlap.
 */
import type { QvacResponse } from "@qvac/infer-base";
import type QvacLoggerType from "@qvac/logging";
import type { TTSConfigurationParams, TTSInterface, TTSJobData } from "../tts";
import type { EngineSetup } from "./engineSetup";
import { buildPocketParams } from "./pocketConfig";
import { isStatsEvent } from "./sentenceStream";
import type { InferenceState } from "./types";

/** What the Pocket rules need from the wrapper that owns the native instance. */
export interface PocketHost {
  readonly setup: EngineSetup;
  readonly state: InferenceState;
  logger(): QvacLoggerType;
  /** The live native instance, or null. */
  optionalAddon(): TTSInterface | null;
  /** Makes `addon` the instance the wrapper reports and routes events from. */
  setAddon(addon: TTSInterface): void;
  /** A new native instance wired to the wrapper's output callback. */
  createAddon(params: TTSConfigurationParams): TTSInterface;
  unloadModel(): Promise<void>;
  /** The response a job is running for, or null when idle. */
  activeJob(): QvacResponse | null;
  /** Fails the active sentence stream, if any, with `reason`. */
  failStream(reason: string): void;
}

interface PendingJob {
  promise: Promise<void>;
  resolve: () => void;
}

export class PocketLifecycle {
  /** The native job awaiting its terminal callback, or null. */
  jobPending: PendingJob | null = null;
  private cancelPromise: Promise<void> | null = null;
  private inProgress = false;

  constructor(private readonly host: PocketHost) {}

  /** A cancel in flight finishes, terminal callback included, before anything else starts. */
  async waitCancel(): Promise<void> {
    if (this.cancelPromise) await this.cancelPromise;
  }

  /** One lifecycle operation at a time; requests are refused while one runs. */
  checkReload(): void {
    if (this.inProgress) {
      throw new Error("Pocket lifecycle operation is already in progress");
    }
  }

  /** A synthesis request needs a loaded instance and no job in flight. */
  checkRequest(): void {
    const { state } = this.host;
    if (state.destroyed) throw new Error("Pocket instance was destroyed");
    if (!state.weightsLoaded || !this.host.optionalAddon()) {
      throw new Error("Pocket model is not loaded");
    }
    if (this.host.activeJob() || this.jobPending) {
      throw new Error("Pocket synthesis is already in progress");
    }
    this.checkReload();
  }

  async withLifecycle(action: () => Promise<void>): Promise<void> {
    await this.waitCancel();
    this.checkReload();
    this.inProgress = true;
    try {
      await action();
    } finally {
      this.inProgress = false;
    }
  }

  /** Runs the job behind a completion barrier that its terminal callback releases. */
  async runJob(addon: TTSInterface, input: TTSJobData): Promise<void> {
    if (this.jobPending) throw new Error("Pocket native job is already in progress");
    let resolve = (): void => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const pending = { promise, resolve };
    this.jobPending = pending;
    try {
      await addon.runJob(input);
    } catch (error) {
      if (this.jobPending === pending) this.jobPending = null;
      resolve();
      throw error;
    }
  }

  /** A terminal native callback (error or stats) releases the completion barrier. */
  onNativeEvent(data: unknown, error: unknown): void {
    const pending = this.jobPending;
    if (!pending) return;
    if ((typeof error === "string" && error.length > 0) || isStatsEvent(data)) {
      this.jobPending = null;
      pending.resolve();
    }
  }

  /**
   * Fails `response` with the caller's reason and stops native work. The
   * completion barrier stays until the terminal callback arrives.
   */
  attachAbort(response: QvacResponse, signal: AbortSignal): void {
    const onAbort = (): void => {
      if (this.host.activeJob() !== response) return;
      const reason: unknown = signal.reason;
      const error =
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? `Aborted: ${reason}` : "Aborted");
      try {
        response.failed(error);
      } finally {
        void this.cancel().catch((error: unknown) =>
          this.host.logger().error("Pocket abort cancellation failed", error),
        );
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const detach = (): void => signal.removeEventListener("abort", onAbort);
    void response.await().then(detach, detach);
  }

  /** Stops native work and waits for the job in flight to report its end. */
  async cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    const addon = this.host.optionalAddon();
    const pending = this.jobPending;
    this.cancelPromise = (async () => {
      this.host.failStream("Synthesis cancelled");
      if (addon?.cancel) await addon.cancel();
      // Joining the worker can precede delivery of its terminal callback.
      if (pending) await pending.promise;
    })();
    try {
      await this.cancelPromise;
    } finally {
      this.cancelPromise = null;
    }
  }

  /**
   * Replaces the native instance with one built from the merged options.
   * Native work is drained and the old model released before the replacement
   * is allocated; a failed activation leaves the instance unloaded with its
   * last good configuration.
   */
  async reload(newConfig: Record<string, unknown>): Promise<void> {
    await this.waitCancel();
    this.checkReload();
    const { setup, state } = this.host;
    if (state.destroyed) throw new Error("Pocket instance was destroyed");
    const pocket = setup.pocket;
    if (!pocket) throw new Error("Pocket engine is not configured");
    const options = { ...pocket.options, ...newConfig };
    const config = { ...setup.config, ...newConfig };
    const params = buildPocketParams(pocket.files, options, config);
    this.inProgress = true;
    let replacement: TTSInterface | null = null;
    try {
      await this.host.unloadModel();
      replacement = this.host.createAddon(params);
      await replacement.activate();
      this.host.setAddon(replacement);
      replacement = null;
      setup.pocket = { files: pocket.files, options, params };
      setup.config.language = "en";
      setup.config.useGPU = false;
      setup.outputSampleRate =
        typeof params.outputSampleRate === "number" ? params.outputSampleRate : null;
      setup.config.outputSampleRate = setup.outputSampleRate ?? undefined;
      state.configLoaded = true;
      state.weightsLoaded = true;
    } finally {
      try {
        if (replacement) await replacement.destroyInstance();
      } finally {
        this.inProgress = false;
      }
    }
  }
}
