/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { OcrGgmlParams } from "./index";

/** Both OCR model files and the backend placement used by load(). */
export interface OcrFitRequest extends OcrGgmlParams {
  /** Bytes to leave free on the selected backend device. */
  marginBytes?: number;
}

/**
 * `unknown` is a load with no reliable verdict: a detector and recognizer on
 * different devices, device memory that cannot be read, no CPU device for the
 * host row, or a load between the conservative upper bound and the source
 * tensors.
 */
export type OcrFitStatus = "fits" | "does-not-fit" | "unknown";

export interface OcrFitDevice {
  /** The PCI bus ID when the backend reports one, the device name otherwise. */
  id: string;
  name: string;
  /** Memory the host owns: the host CPU, and a GPU that shares the host's memory. */
  unified: boolean;
  /** The conservative weight-load estimate on this device. */
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
}

export type OcrFitStats = Record<string, never>;

export interface OcrFitResult {
  status: OcrFitStatus;
  /**
   * The selected device, then the host CPU, which holds a discrete GPU's GGUF
   * staging copies. One CPU row for a load on the CPU, and none for `unknown`.
   */
  devices: OcrFitDevice[];
  stats: OcrFitStats;
}

/**
 * Assess loading the detector and recognizer weights from GGUF metadata.
 * This does not load weights or account for image-dependent inference memory.
 *
 * Concurrent calls run one at a time. A model that cannot be read, a host with
 * no backend device, or an invalid request rejects.
 */
export async function assessFit(request: OcrFitRequest): Promise<OcrFitResult> {
  for (const key of ["pathDetector", "pathRecognizer"] as const) {
    if (typeof request[key] !== "string" || !path.isAbsolute(request[key])) {
      throw new TypeError(`${key} must be an absolute path`);
    }
  }
  if (
    request.marginBytes !== undefined &&
    (!Number.isSafeInteger(request.marginBytes) || request.marginBytes < 0)
  ) {
    throw new RangeError("marginBytes must be a non-negative safe integer");
  }

  // Resolve lazily so importing this package never loads the native binding.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native prebuild is resolved lazily.
  const binding = require("./binding") as {
    assessFit(input: OcrFitRequest): Promise<OcrFitResult>;
  };
  return await binding.assessFit(request);
}
