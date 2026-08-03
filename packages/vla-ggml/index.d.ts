import QvacLogger = require("@qvac/logging");
import addonModule = require("./addon");
import errorModule = require("./lib/error");
interface VlaConfig {
    verbosity?: number;
    backendsDir?: string;
    embodiment?: VlaModel.VlaEmbodimentSelector;
    [key: string]: unknown;
}
interface VlaModelState {
    configLoaded: boolean;
    weightsLoaded: boolean;
}
declare class VlaModel {
    readonly logger: QvacLogger;
    opts: {
        stats?: boolean;
    };
    state: VlaModelState;
    private _files;
    private _config;
    private _job;
    private _run;
    private _handle;
    private _hparams;
    private _backendName;
    private _hasActiveResponse;
    private _nativeLoggerActive;
    private _packageName;
    private _packageVersion;
    private _pending;
    constructor(options: VlaModel.VlaModelOptions);
    private _connectNativeLogger;
    private _onAddonEvent;
    private _releaseNativeLogger;
    load({ backend }?: {
        backend?: "auto" | "cpu";
    }): Promise<void>;
    private _load;
    get hparams(): VlaModel.VlaHparams | null;
    get backendName(): string | null;
    setEmbodiment(embodiment: VlaModel.VlaEmbodimentSelector): Promise<VlaModel.VlaHparams>;
    private _setEmbodimentInternal;
    run(input: VlaModel.VlaRunInput): Promise<VlaModel.QvacResponse>;
    private _runInternal;
    pause(): Promise<void>;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    getState(): VlaModelState;
}
import VlaModelClass = VlaModel;
/**
 * Declaration merging with the class above models this package's CommonJS
 * export shape — `module.exports` IS the `VlaModel` constructor, carrying the
 * named exports as own properties — directly in the type system. TypeScript
 * emits the property attachments natively, so the generated `index.js` and
 * `index.d.ts` can no longer drift from each other, and a CommonJS consumer
 * (`import VlaModel = require('@qvac/vla-ggml')`) gets a real construct
 * signature instead of TS2351.
 */
declare namespace VlaModel {
    export import VlaModel = VlaModelClass;
    export import preprocessImage = addonModule.preprocessImage;
    export import padState = addonModule.padState;
    export import DEFAULT_IMAGE_SIZE = addonModule.DEFAULT_IMAGE_SIZE;
    export import QvacErrorAddonVla = errorModule.QvacErrorAddonVla;
    export import ERR_CODES = errorModule.ERR_CODES;
    interface VlaHparams {
        chunkSize: number;
        actionDim: number;
        maxActionDim: number;
        maxStateDim: number;
        tokenizerMaxLength: number;
        visionImageSize: number;
        /**
         * Number of camera views the model accepts. 2 for SmolVLA, up to 3 for
         * π₀.₅. Optional for back-compat — older addon builds may omit it.
         */
        numCameras?: number;
        /**
         * How the consumer passes the robot state. `'continuous'` (SmolVLA) means
         * the `state` Float32Array is projected by an in-model linear layer;
         * `'discrete'` (π₀.₅) means the state is already tokenized into the
         * language prompt and the `state` buffer is ignored. Optional for
         * back-compat.
         */
        stateInputMode?: "continuous" | "discrete";
        /**
         * How the consumer passes camera images. `'pixels'` (SmolVLA, π₀.₅) means
         * each image is a `3 · w · h` float pixel plane; `'patches'` (GR00T) means
         * each image is already patchified by Gr00tPolicy into a
         * `patches · patch_flat` buffer. Optional for back-compat.
         */
        imageInputMode?: "pixels" | "patches";
        /**
         * Exact per-image buffer length (in floats) required when
         * `imageInputMode === 'patches'`. Optional for back-compat.
         */
        imagePatchElems?: number;
        /**
         * GR00T only: the embodiment tag resolved at load, so a caller can confirm
         * which embodiment a default selection picked. Absent for SmolVLA / π₀.₅,
         * and for a GR00T GGUF that names no embodiment.
         *
         * Present is not the same as switchable: a single-embodiment GR00T GGUF
         * reports its baked tag here and still rejects every {@link
         * VlaModel.setEmbodiment} call, so do not use this field as a capability
         * check.
         */
        selectedEmbodimentTag?: string;
        /**
         * The resolved embodiment's numeric id (the checkpoint's `cat_id`) — the
         * value to pass back to select the same embodiment by id. Absent when no
         * embodiment was resolved (SmolVLA / π₀.₅).
         *
         * Many tags map to one `cat_id`, so selecting by id reports that id's
         * canonical tag (the first in the GGUF's tag map), which may differ from the
         * alias a tag-based selection was made with. The id is the stable identity.
         */
        selectedEmbodimentCatId?: number;
    }
    /**
     * How an embodiment is named when selecting one: a tag string, its numeric
     * `cat_id` in `0..31`, or an object carrying either plus a camera-count
     * override. `cat_id` indexes GR00T's CategorySpecificLinear bank, whose
     * category dim the architecture fixes at 32, so ids outside that range are
     * rejected rather than resolved.
     *
     * `numCameras` overrides the count stored in the GGUF for that embodiment. It
     * is required to select a row whose count was unknown at conversion time
     * (`num_cameras` is a data-config property, not a checkpoint tensor), and it
     * also covers a rig whose view count differs from the stored one. Passing both
     * `tag` and `catId` is an error.
     */
    type VlaEmbodimentSelector = string | number | {
        tag?: string;
        catId?: number;
        numCameras?: number;
    };
    interface VlaRunInput {
        images: Float32Array[];
        imgWidth?: number;
        imgHeight?: number;
        state: Float32Array;
        tokens: Int32Array;
        mask: Uint8Array;
        noise?: Float32Array | null;
    }
    interface VlaRunStats {
        vision_ms: number;
        /**
         * SmolVLA-specific legacy alias for `prefill_compute_ms`. Kept for
         * back-compat with consumers written against v0.1.x; will be removed once
         * π₀.₅ ships and consumers migrate to the architecture-neutral names.
         */
        smollm2_compute_ms: number;
        /** Legacy alias for `prefill_total_ms`; see `smollm2_compute_ms`. */
        smollm2_total_ms: number;
        /** Architecture-neutral prefill compute time (ms). */
        prefill_compute_ms: number;
        /** Architecture-neutral prefill total time (ms). */
        prefill_total_ms: number;
        ode_ms: number;
        total_ms: number;
        /** 0 = CPU backend, 1 = GPU backend (Vulkan / Metal / OpenCL). */
        backendDevice: number;
    }
    interface VlaRunResult {
        actions: Float32Array;
        stats: VlaRunStats;
    }
    interface VlaModelOptions {
        files: {
            model: string[];
        };
        config?: VlaConfig;
        logger?: QvacLogger.LoggerInterface | null;
        opts?: {
            stats?: boolean;
        };
    }
    interface QvacResponse {
        await(): Promise<VlaRunResult>;
        cancel(): Promise<void>;
        on(event: string, listener: (...args: unknown[]) => void): this;
    }
}
export = VlaModel;
