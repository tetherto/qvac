/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

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
  /** Bytes to leave free on every memory pool the load uses. Default 256 MiB. */
  marginBytes?: number;
  /**
   * BridgeDepth input size; ignored for the other models. The default
   * 1280x720 is the largest input the model authors recommend; they suggest
   * downsampling anything above 720p first. The addon does not downsample.
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

// Matches the `threads` bound createInstance enforces in the native addon.
const MAX_THREADS = 1024;

// The native side reads paths as C strings, which stop at the first NUL.
function checkNoNul(value: string | undefined, name: string): void {
  if (typeof value === "string" && value.includes("\0")) {
    throw new TypeError(`${name} must not contain a NUL character`);
  }
}

function checkPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
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
export async function assessFit(request: ClassificationFitRequest): Promise<ClassificationFitResult> {
  if (typeof request?.modelPath !== "string" || !path.isAbsolute(request.modelPath)) {
    throw new TypeError("modelPath must be an absolute path");
  }
  checkNoNul(request.modelPath, "modelPath");
  checkNoNul(request.backendsDir, "backendsDir");
  if (
    request.marginBytes !== undefined &&
    (!Number.isSafeInteger(request.marginBytes) || request.marginBytes < 0)
  ) {
    throw new RangeError("marginBytes must be a non-negative safe integer");
  }
  if (
    request.threads !== undefined &&
    (!Number.isInteger(request.threads) || request.threads < 1 || request.threads > MAX_THREADS)
  ) {
    throw new RangeError(`threads must be an integer between 1 and ${MAX_THREADS}`);
  }
  checkPositiveInteger(request.workload?.width, "workload.width");
  checkPositiveInteger(request.workload?.height, "workload.height");

  // Resolve lazily so importing this package never loads the native binding.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native prebuild is resolved lazily.
  const binding = require("./binding") as {
    assessFit(input: ClassificationFitRequest): Promise<ClassificationFitResult>;
  };
  return await binding.assessFit(request);
}
