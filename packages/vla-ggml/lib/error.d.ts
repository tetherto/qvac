import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
export declare class QvacErrorAddonVla extends QvacErrorBase {
}
export declare const ERR_CODES: Readonly<{
    FAILED_TO_LOAD_WEIGHTS: 30001;
    FAILED_TO_DESTROY: 30002;
    MODEL_NOT_FOUND: 30003;
    INVALID_CONFIG: 30004;
    MISSING_REQUIRED_PARAMETER: 30005;
    INVALID_INPUT: 30006;
    JOB_ALREADY_RUNNING: 30007;
    INSTANCE_NOT_INITIALIZED: 30008;
    MODEL_UNLOADED: 30009;
    INFERENCE_FAILED: 30010;
}>;
export {};
