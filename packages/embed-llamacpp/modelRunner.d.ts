import QvacLogger = require("@qvac/logging");
import { type QvacResponse } from "@qvac/infer-base";
import { type AddonOutputCallback, type LoadWeightsData } from "./addon";
/** A native event normalized by a model's event mapper. */
export type MappedModelEvent<Output> = {
    type: "JobEnded";
    data: unknown;
    error: null;
} | {
    type: "Error";
    data: unknown;
    error: unknown;
} | {
    type: "Output";
    data: Output;
    error: null;
};
export interface ModelConfigurationParams<Config> {
    path: string;
    config: Config;
    backendsDir?: string;
}
/** The binding calls every native model instance shares. */
export interface ModelBinding {
    activate(handle: unknown): Promise<void> | void;
    loadWeights(handle: unknown, data: LoadWeightsData): Promise<void>;
    cancel(handle: unknown): Promise<void>;
    destroyInstance(handle: unknown): void;
}
/**
 * An interface between one native model instance and the JS runtime. A
 * subclass creates the instance and adds its own `runJob`.
 */
export declare abstract class ModelInterface<Config, Binding extends ModelBinding> {
    protected readonly _binding: Binding;
    protected _handle: object | null;
    constructor(binding: unknown, configurationParams: ModelConfigurationParams<Config>, outputCb: AddonOutputCallback);
    /**
     * Creates the native instance this interface owns, through `_binding`.
     * Called from the constructor, so it must not use the subclass's fields.
     */
    protected abstract _createInstance(configurationParams: ModelConfigurationParams<Config>, outputCb: AddonOutputCallback): object;
    cancel(): Promise<void>;
    loadWeights(data: LoadWeightsData): Promise<void>;
    activate(): Promise<void>;
    unload(): Promise<void>;
}
export interface ModelRunnerArgs<Config> {
    files: {
        model: string[];
    };
    /** Required, with at least `device`. */
    config: Config;
    logger?: QvacLogger | Console | null;
    opts?: {
        stats?: boolean;
    };
}
/**
 * The lifecycle a standalone model class shares: load (streaming shards),
 * one request at a time, cancel and unload, over its own native instance.
 * A subclass names the model and supplies how the instance is created, how a
 * request becomes the job's input, and how native events map to outputs.
 */
export declare abstract class ModelRunner<Config, Request, Payload, Output, Addon extends ModelInterface<Config, ModelBinding>> {
    logger: QvacLogger;
    opts: {
        stats?: boolean;
    };
    state: {
        configLoaded: boolean;
    };
    protected _addon: Addon | null;
    private readonly _files;
    private readonly _config;
    private readonly _job;
    private readonly _run;
    private _hasActiveResponse;
    /** Names the model in log messages, e.g. "Laya". */
    protected abstract readonly _modelName: string;
    constructor({ files, config, logger, opts }: ModelRunnerArgs<Config>);
    /** Creates the native instance from the package's binding. */
    protected abstract _createAddon(binding: unknown, configurationParams: ModelConfigurationParams<Config>, outputCb: AddonOutputCallback): Addon;
    /** Turns a request into the job's input; runs before the job starts. */
    protected abstract _encodeRequest(request: Request): Payload;
    /** Hands the input to the native instance: `true` if accepted. */
    protected abstract _startJob(addon: Addon, payload: Payload): Promise<boolean>;
    /** The package's native binding, resolved lazily from its prebuilds. */
    protected _loadBinding(): unknown;
    /** Normalizes a native event; throws on malformed output. */
    protected abstract _mapEvent(event: unknown, data: unknown, error: unknown): MappedModelEvent<Output> | null;
    load(): Promise<void>;
    private _load;
    private _streamShards;
    /** Runs one request; a subclass's `run()` checks and forwards it here. */
    protected _runRequest(request: Request): Promise<QvacResponse<Output>>;
    private _runInternal;
    private _outputCallback;
    /** Unload the model and clear resources. Fails any in-flight job. */
    unload(): Promise<void>;
    /** Cancel the current request. */
    cancel(): Promise<void>;
    getState(): {
        configLoaded: boolean;
    };
}
