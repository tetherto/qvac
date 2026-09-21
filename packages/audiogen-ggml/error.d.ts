import QvacError = require('@qvac/error');
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
export declare class QvacErrorAudioGen extends QvacErrorBase {
}
export declare const ERR_CODE_RANGE: Readonly<{
    start: 31001;
    end: 32000;
}>;
export declare const ERR_CODES: Readonly<{
    INVALID_INPUT: 31001;
    NOT_LOADED: 31002;
    CANCELLED: 31003;
    MODEL_UNLOADED: 31004;
    INSTANCE_DESTROYED: 31005;
    JOB_ALREADY_RUNNING: 31006;
    FAILED_TO_START_JOB: 31007;
    FAILED_TO_CANCEL: 31008;
    FAILED_TO_DESTROY: 31009;
    FAILED_TO_LOAD: 31010;
    INFERENCE_FAILED: 31011;
}>;
export {};
