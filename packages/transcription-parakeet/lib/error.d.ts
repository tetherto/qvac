import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
type QvacErrorOptions = ConstructorParameters<typeof QvacErrorBase>[0];
export declare class QvacErrorAddonParakeet extends QvacErrorBase {
    constructor(options?: QvacErrorOptions | number);
}
export declare const ERR_CODES: Readonly<{
    FAILED_TO_LOAD_WEIGHTS: 24001;
    FAILED_TO_CANCEL: 24002;
    FAILED_TO_APPEND: 24003;
    FAILED_TO_GET_STATUS: 24004;
    FAILED_TO_DESTROY: 24005;
    FAILED_TO_ACTIVATE: 24006;
    FAILED_TO_RESET: 24007;
    FAILED_TO_PAUSE: 24008;
    MODEL_NOT_FOUND: 24009;
    INVALID_AUDIO_FORMAT: 24010;
    INVALID_CONFIG: 24015;
    JOB_ALREADY_RUNNING: 24016;
    BUFFER_LIMIT_EXCEEDED: 24017;
    INSTANCE_DESTROYED: 24018;
    JOB_CANCELLED: 24019;
}>;
export declare const END_OF_INPUT = "end of job";
export {};
