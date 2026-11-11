/** The input a BridgeDepth inference would be given. */
export interface ClassificationFitWorkload {
    /** Input width in pixels. Default 1280. */
    width?: number;
    /** Input height in pixels. Default 720. */
    height?: number;
}
/** A MobileNet, MegaLoc or BridgeDepth GGUF and the placement load() would use. */
export interface ClassificationFitRequest {
    /** Absolute path to the GGUF. The model kind is read from the file. */
    modelPath: string;
    /**
     * Exact ggml device name, as MegaLoc and BridgeDepth take it. Omitted picks
     * a GPU, then an integrated GPU, then the CPU. MobileNet always runs on the
     * CPU and ignores it.
     */
    backend?: string;
    /**
     * Directory to load dynamic ggml backends from. Every library in it is
     * loaded as native code, so it must be a trusted directory, as for
     * `createInstance`.
     */
    backendsDir?: string;
    /** CPU threads the model will run with, 1 to 1024. Default 8, as MegaLoc and BridgeDepth. */
    threads?: number;
    /** Bytes to leave free on every memory pool the load uses. Default 0. */
    marginBytes?: number;
    /**
     * BridgeDepth input size; ignored for the other models. The default
     * 1280x720 is the largest input upstream runs without downsampling, and is
     * pending a product decision.
     */
    workload?: ClassificationFitWorkload;
}
/** `unknown` means a device's memory could not be read, or there is no CPU device. */
export type ClassificationFitStatus = "fits" | "does-not-fit" | "unknown";
export interface ClassificationFitDevice {
    /** The PCI bus ID when the backend reports one, the device name otherwise. */
    id: string;
    name: string;
    /** Memory the host owns: the host CPU, and a GPU that shares the host's memory. */
    unified: boolean;
    /** The measured weights, compute buffers and host staging the load and an inference take here. */
    usedBytes: number;
    freeBytes: number;
    totalBytes: number;
}
export type ClassificationFitStats = Record<string, never>;
export interface ClassificationFitResult {
    status: ClassificationFitStatus;
    /**
     * The selected device, then the host CPU, which holds the CPU fallback
     * compute buffer and workspace and the addon's host staging. One CPU row for
     * a load on the CPU, and none for `unknown`. A unified device and the host
     * are judged together against the lower of their free figures.
     */
    devices: ClassificationFitDevice[];
    stats: ClassificationFitStats;
}
/**
 * Assess loading a model and running one inference, from the GGUF metadata.
 * The graphs are built and sized as load and inference build them, without
 * reading weight data or allocating buffers. Tensor data is not checked, so
 * a file whose weights `load()` rejects can still be reported as fitting.
 *
 * Each call initializes the selected backend, so it costs about what a
 * backend init costs. Concurrent calls run one at a time. A request that fails the checks here
 * rejects with a `TypeError` or `RangeError`. A model that cannot be read, an
 * unsupported GGUF, an unavailable backend, a BridgeDepth size inference would
 * reject or an otherwise invalid request rejects with an `InvalidArgument`
 * error; a backend that fails to initialize or a graph that cannot be sized
 * rejects with an `InternalError`.
 */
export declare function assessFit(request: ClassificationFitRequest): Promise<ClassificationFitResult>;
