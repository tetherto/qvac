import type { OcrGgmlParams } from "./index";
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
export declare function assessFit(request: OcrFitRequest): OcrFitResult;
