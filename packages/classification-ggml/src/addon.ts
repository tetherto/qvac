export interface AddonLogger {
  error?: (message: string) => void;
  warn?: (message: string) => void;
  info?: (message: string) => void;
  debug?: (message: string) => void;
}

type NativeLoggerCallback = (priority: number, message: string) => void;

export interface ClassificationBinding {
  setLogger(callback: NativeLoggerCallback): void;
  createInstance(
    owner: ClassificationInterface,
    configurationParams: ClassificationConfigurationParams,
    outputCallback: ClassificationOutputCallback,
  ): object;
  activate(handle: unknown): void;
  runJob(handle: unknown, input: ClassificationJob): Promise<boolean>;
  cancel(handle: unknown): Promise<void>;
  destroyInstance(handle: unknown): void;
}

export interface ClassificationConfigurationParams {
  path: string;
  config: {
    backendsDir: string;
  };
}

export interface ClassificationJob {
  type: "image";
  content: Uint8Array;
  width?: number;
  height?: number;
  channels?: 3;
  topK?: number;
}

export type ClassificationOutputCallback = (
  addon: ClassificationInterface,
  event: unknown,
  data: unknown,
  error: unknown,
) => void;

export interface ClassificationInterfaceOptions {
  disableNativeLogger?: boolean;
}

export type MappedAddonEvent =
  | {
      type: "Error";
      data: unknown;
      error: unknown;
    }
  | {
      type: "LogMsg";
      data: unknown;
      error: null;
    }
  | {
      type: "JobEnded";
      data: unknown;
      error: null;
    }
  | {
      type: "Output";
      data: unknown[];
      error: null;
    }
  | {
      type: string;
      data: unknown;
      error: unknown;
    };

// Native JsLogger is a process-wide singleton (static uv_async_t in
// addon-cpp); install its JS callback once, switch sinks per instance.
let loggerInstalled = false;
let activeLoggerSink: AddonLogger | null = null;

function ensureLoggerInstalled(binding: ClassificationBinding): void {
  if (loggerInstalled) return;
  const levels = ["error", "warn", "info", "debug"] as const;
  binding.setLogger((priority, message) => {
    const sink = activeLoggerSink;
    if (!sink) return;
    const level = levels[priority] || "info";
    const write = sink[level];
    if (typeof write === "function") {
      try {
        write(message);
      } catch {}
    }
  });
  loggerInstalled = true;
}

function setActiveLoggerSink(sink: AddonLogger): void {
  activeLoggerSink = sink;
}

function clearActiveLoggerSink(sink: AddonLogger): void {
  if (activeLoggerSink === sink) activeLoggerSink = null;
}

/**
 * Normalize a raw native event to `Output` / `Error` / `LogMsg` /
 * `JobEnded`, or `null` to drop. Keyed on payload shape because the
 * upstream JobRunner emits the stats trailer with a raw RTTI event
 * name (no `JobEnded` substring), so an array -> `Output` and a plain
 * object -> terminal `JobEnded`.
 */
export function mapAddonEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown,
): MappedAddonEvent | null {
  if (typeof rawEvent === "string") {
    if (rawEvent.includes("Error")) {
      return { type: "Error", data: rawData, error: rawError };
    }
    if (rawEvent.includes("LogMsg")) {
      return { type: "LogMsg", data: rawData, error: null };
    }
    if (rawEvent.includes("JobEnded")) {
      return { type: "JobEnded", data: rawData, error: null };
    }
    if (rawEvent.includes("JobStarted")) {
      return null;
    }
  }
  if (Array.isArray(rawData)) {
    return { type: "Output", data: rawData, error: null };
  }
  if (rawData && typeof rawData === "object") {
    return { type: "JobEnded", data: rawData, error: null };
  }
  return {
    type: typeof rawEvent === "string" ? rawEvent : "Unknown",
    data: rawData,
    error: rawError,
  };
}

/**
 * Thin JS-to-native bridge owning one bare C++ instance handle. Lifecycle
 * lives in `index.js`, mirroring `LlamaInterface` / `LlmLlamacpp`.
 *
 * `opts.disableNativeLogger` controls whether the native LogMsg bridge is
 * armed for this instance; kept on a sibling arg so `configurationParams`
 * stays 1:1 with the C++ schema (no JS-only `__`-prefixed flags).
 */
export class ClassificationInterface {
  private readonly binding: ClassificationBinding;
  private handle: object | null;
  private readonly logger: AddonLogger | null;

  constructor(
    binding: ClassificationBinding,
    configurationParams: ClassificationConfigurationParams,
    outputCallback: ClassificationOutputCallback,
    logger: AddonLogger | null = null,
    opts: ClassificationInterfaceOptions = {},
  ) {
    this.binding = binding;
    this.handle = null;
    this.logger = logger;

    if (logger && typeof logger === "object" && !opts.disableNativeLogger) {
      ensureLoggerInstalled(binding);
      setActiveLoggerSink(logger);
    }

    this.handle = this.binding.createInstance(
      this,
      configurationParams,
      outputCallback,
    );
  }

  activate(): Promise<void> {
    if (!this.handle) throw new Error("Classification addon is not initialized");
    this.binding.activate(this.handle);
    return Promise.resolve();
  }

  async runJob(input: ClassificationJob): Promise<boolean> {
    if (!this.handle) throw new Error("Classification addon is not initialized");
    return this.binding.runJob(this.handle, input);
  }

  async cancel(): Promise<void> {
    if (!this.handle) return;
    await this.binding.cancel(this.handle);
  }

  unload(): Promise<void> {
    if (this.handle === null) return Promise.resolve();
    if (this.logger) clearActiveLoggerSink(this.logger);
    try {
      this.binding.destroyInstance(this.handle);
    } finally {
      this.handle = null;
    }
    return Promise.resolve();
  }
}

