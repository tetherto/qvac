/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { OcrGgmlParams } from "./index";
import { resolveBackendsDir } from "./lib/backends-dir";

/** Both OCR model files and the backend placement used by load(). */
export interface OcrFitRequest extends OcrGgmlParams {
  /** Bytes to leave free on the selected backend device. */
  marginBytes?: number;
}

export interface OcrFitResult {
  status: "fits" | "does-not-fit" | "error";
  reason: string;
  deviceName: string;
  deviceBytes: number;
  hostBytes: number;
  weightsBytes: number;
  deviceFreeBytes: number;
  deviceTotalBytes: number;
  report: string;
}

/**
 * Assess loading the detector and recognizer weights from GGUF metadata.
 * This does not load weights or account for image-dependent inference memory.
 * `error` means no reliable capacity verdict was available.
 */
export function assessFit(request: OcrFitRequest): OcrFitResult {
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
    assessFit(input: OcrFitRequest): OcrFitResult;
  };
  return binding.assessFit({
    ...request,
    backendsDir: request.backendsDir ?? resolveBackendsDir(),
  });
}
