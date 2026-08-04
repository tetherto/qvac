import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
export declare class QvacErrorAddonBCI extends QvacErrorBase {
}
/** Extract a human-readable message from an unknown thrown value. */
export declare function errorMessage(err: unknown): string;
export declare const ERR_CODES: Readonly<{
    FAILED_TO_LOAD_WEIGHTS: 26001;
    FAILED_TO_CANCEL: 26002;
    FAILED_TO_APPEND: 26003;
    FAILED_TO_DESTROY: 26004;
    FAILED_TO_ACTIVATE: 26005;
    INVALID_NEURAL_INPUT: 26006;
    JOB_ALREADY_RUNNING: 26007;
    MODEL_NOT_LOADED: 26008;
    MODEL_FILE_NOT_FOUND: 26009;
    BUFFER_LIMIT_EXCEEDED: 26010;
    FAILED_TO_START_JOB: 26011;
    INVALID_CONFIG: 26012;
    EMBEDDER_WEIGHTS_INVALID: 26013;
    STREAM_ALREADY_ACTIVE: 26014;
    INVALID_STREAM_INPUT: 26015;
    INVALID_STREAM_HEADER: 26016;
    WINDOW_TOO_LARGE: 26017;
}>;
export {};
