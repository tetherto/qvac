"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PocketLifecycle = void 0;
const pocketConfig_1 = require("./pocketConfig");
const sentenceStream_1 = require("./sentenceStream");
class PocketLifecycle {
    host;
    /** The native job awaiting its terminal callback, or null. */
    jobPending = null;
    cancelPromise = null;
    inProgress = false;
    constructor(host) {
        this.host = host;
    }
    /** A cancel in flight finishes, terminal callback included, before anything else starts. */
    async waitCancel() {
        if (this.cancelPromise)
            await this.cancelPromise;
    }
    /** One lifecycle operation at a time; requests are refused while one runs. */
    checkReload() {
        if (this.inProgress) {
            throw new Error("Pocket lifecycle operation is already in progress");
        }
    }
    /** A synthesis request needs a loaded instance and no job in flight. */
    checkRequest() {
        const { state } = this.host;
        if (state.destroyed)
            throw new Error("Pocket instance was destroyed");
        if (!state.weightsLoaded || !this.host.optionalAddon()) {
            throw new Error("Pocket model is not loaded");
        }
        if (this.host.activeJob() || this.jobPending) {
            throw new Error("Pocket synthesis is already in progress");
        }
        this.checkReload();
    }
    async withLifecycle(action) {
        await this.waitCancel();
        this.checkReload();
        this.inProgress = true;
        try {
            await action();
        }
        finally {
            this.inProgress = false;
        }
    }
    /** Runs the job behind a completion barrier that its terminal callback releases. */
    async runJob(addon, input) {
        if (this.jobPending)
            throw new Error("Pocket native job is already in progress");
        let resolve = () => { };
        const promise = new Promise((done) => {
            resolve = done;
        });
        const pending = { promise, resolve };
        this.jobPending = pending;
        try {
            await addon.runJob(input);
        }
        catch (error) {
            if (this.jobPending === pending)
                this.jobPending = null;
            resolve();
            throw error;
        }
    }
    /** A terminal native callback (error or stats) releases the completion barrier. */
    onNativeEvent(data, error) {
        const pending = this.jobPending;
        if (!pending)
            return;
        if ((typeof error === "string" && error.length > 0) || (0, sentenceStream_1.isStatsEvent)(data)) {
            this.jobPending = null;
            pending.resolve();
        }
    }
    /**
     * Fails `response` with the caller's reason and stops native work. The
     * completion barrier stays until the terminal callback arrives.
     */
    attachAbort(response, signal) {
        const onAbort = () => {
            if (this.host.activeJob() !== response)
                return;
            const reason = signal.reason;
            const error = reason instanceof Error
                ? reason
                : new Error(typeof reason === "string" ? `Aborted: ${reason}` : "Aborted");
            try {
                response.failed(error);
            }
            finally {
                void this.cancel().catch((error) => this.host.logger().error("Pocket abort cancellation failed", error));
            }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const detach = () => signal.removeEventListener("abort", onAbort);
        void response.await().then(detach, detach);
    }
    /** Stops native work and waits for the job in flight to report its end. */
    async cancel() {
        if (this.cancelPromise)
            return this.cancelPromise;
        const addon = this.host.optionalAddon();
        const pending = this.jobPending;
        this.cancelPromise = (async () => {
            this.host.failStream("Synthesis cancelled");
            if (addon?.cancel)
                await addon.cancel();
            // Joining the worker can precede delivery of its terminal callback.
            if (pending)
                await pending.promise;
        })();
        try {
            await this.cancelPromise;
        }
        finally {
            this.cancelPromise = null;
        }
    }
    /**
     * Replaces the native instance with one built from the merged options.
     * Native work is drained and the old model released before the replacement
     * is allocated; a failed activation leaves the instance unloaded with its
     * last good configuration.
     */
    async reload(newConfig) {
        await this.waitCancel();
        this.checkReload();
        const { setup, state } = this.host;
        if (state.destroyed)
            throw new Error("Pocket instance was destroyed");
        const pocket = setup.pocket;
        if (!pocket)
            throw new Error("Pocket engine is not configured");
        const options = { ...pocket.options, ...newConfig };
        const config = { ...setup.config, ...newConfig };
        const params = (0, pocketConfig_1.buildPocketParams)(pocket.files, options, config);
        this.inProgress = true;
        let replacement = null;
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
        }
        finally {
            try {
                if (replacement)
                    await replacement.destroyInstance();
            }
            finally {
                this.inProgress = false;
            }
        }
    }
}
exports.PocketLifecycle = PocketLifecycle;
