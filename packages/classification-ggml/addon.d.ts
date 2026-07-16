export interface AddonLogger {
    error?: (message: string) => void;
    warn?: (message: string) => void;
    info?: (message: string) => void;
    debug?: (message: string) => void;
}
type NativeLoggerCallback = (priority: number, message: string) => void;
export interface ClassificationBinding {
    setLogger(callback: NativeLoggerCallback): void;
    createInstance(owner: ClassificationInterface, configurationParams: ClassificationConfigurationParams, outputCallback: ClassificationOutputCallback): object;
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
export type ClassificationOutputCallback = (addon: ClassificationInterface, event: unknown, data: unknown, error: unknown) => void;
export interface ClassificationInterfaceOptions {
    disableNativeLogger?: boolean;
}
export type MappedAddonEvent = {
    type: "Error";
    data: unknown;
    error: unknown;
} | {
    type: "LogMsg";
    data: unknown;
    error: null;
} | {
    type: "JobEnded";
    data: unknown;
    error: null;
} | {
    type: "Output";
    data: unknown[];
    error: null;
} | {
    type: string;
    data: unknown;
    error: unknown;
};
/**
 * Normalize a raw native event to `Output` / `Error` / `LogMsg` /
 * `JobEnded`, or `null` to drop. Keyed on payload shape because the
 * upstream JobRunner emits the stats trailer with a raw RTTI event
 * name (no `JobEnded` substring), so an array -> `Output` and a plain
 * object -> terminal `JobEnded`.
 */
export declare function mapAddonEvent(rawEvent: unknown, rawData: unknown, rawError: unknown): MappedAddonEvent | null;
/**
 * Thin JS-to-native bridge owning one bare C++ instance handle. Lifecycle
 * lives in `index.js`, mirroring `LlamaInterface` / `LlmLlamacpp`.
 *
 * `opts.disableNativeLogger` controls whether the native LogMsg bridge is
 * armed for this instance; kept on a sibling arg so `configurationParams`
 * stays 1:1 with the C++ schema (no JS-only `__`-prefixed flags).
 */
export declare class ClassificationInterface {
    private readonly binding;
    private handle;
    private readonly logger;
    constructor(binding: ClassificationBinding, configurationParams: ClassificationConfigurationParams, outputCallback: ClassificationOutputCallback, logger?: AddonLogger | null, opts?: ClassificationInterfaceOptions);
    activate(): Promise<void>;
    runJob(input: ClassificationJob): Promise<boolean>;
    cancel(): Promise<void>;
    unload(): Promise<void>;
}
export {};
