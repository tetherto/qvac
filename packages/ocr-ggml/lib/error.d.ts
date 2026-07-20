import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
export declare class QvacErrorAddonOcrGgml extends QvacErrorBase {
}
/** Extract a human-readable message from an unknown thrown value. */
export declare function errorMessage(err: unknown): string;
export declare const ERR_CODES: Readonly<{
    FAILED_TO_LOAD_WEIGHTS: 8101;
    FAILED_TO_CANCEL: 8102;
    FAILED_TO_RUN_JOB: 8103;
    FAILED_TO_GET_STATUS: 8104;
    FAILED_TO_DESTROY: 8105;
    FAILED_TO_ACTIVATE: 8106;
    MISSING_REQUIRED_PARAMETER: 8107;
    UNSUPPORTED_LANGUAGE: 8108;
    INVALID_IMAGE_OR_INSUFFICIENT_DATA: 8109;
    UNSUPPORTED_IMAGE_FORMAT: 8110;
    NOT_LOADED: 8111;
}>;
export {};
