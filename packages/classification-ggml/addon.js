"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClassificationInterface = void 0;
exports.mapAddonEvent = mapAddonEvent;
// Native JsLogger is a process-wide singleton (static uv_async_t in
// addon-cpp); install its JS callback once, switch sinks per instance.
let loggerInstalled = false;
let activeLoggerSink = null;
function ensureLoggerInstalled(binding) {
    if (loggerInstalled)
        return;
    const levels = ["error", "warn", "info", "debug"];
    binding.setLogger((priority, message) => {
        const sink = activeLoggerSink;
        if (!sink)
            return;
        const level = levels[priority] || "info";
        const write = sink[level];
        if (typeof write === "function") {
            try {
                write(message);
            }
            catch { }
        }
    });
    loggerInstalled = true;
}
function setActiveLoggerSink(sink) {
    activeLoggerSink = sink;
}
function clearActiveLoggerSink(sink) {
    if (activeLoggerSink === sink)
        activeLoggerSink = null;
}
/**
 * Normalize a raw native event to `Output` / `Error` / `LogMsg` /
 * `JobEnded`, or `null` to drop. Keyed on payload shape because the
 * upstream JobRunner emits the stats trailer with a raw RTTI event
 * name (no `JobEnded` substring), so an array -> `Output` and a plain
 * object -> terminal `JobEnded`.
 */
function mapAddonEvent(rawEvent, rawData, rawError) {
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
class ClassificationInterface {
    binding;
    handle;
    logger;
    constructor(binding, configurationParams, outputCallback, logger = null, opts = {}) {
        this.binding = binding;
        this.handle = null;
        this.logger = logger;
        if (logger && typeof logger === "object" && !opts.disableNativeLogger) {
            ensureLoggerInstalled(binding);
            setActiveLoggerSink(logger);
        }
        this.handle = this.binding.createInstance(this, configurationParams, outputCallback);
    }
    activate() {
        if (!this.handle)
            throw new Error("Classification addon is not initialized");
        this.binding.activate(this.handle);
        return Promise.resolve();
    }
    async runJob(input) {
        if (!this.handle)
            throw new Error("Classification addon is not initialized");
        return this.binding.runJob(this.handle, input);
    }
    async cancel() {
        if (!this.handle)
            return;
        await this.binding.cancel(this.handle);
    }
    unload() {
        if (this.handle === null)
            return Promise.resolve();
        if (this.logger)
            clearActiveLoggerSink(this.logger);
        try {
            this.binding.destroyInstance(this.handle);
        }
        finally {
            this.handle = null;
        }
        return Promise.resolve();
    }
}
exports.ClassificationInterface = ClassificationInterface;
