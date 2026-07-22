import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
export declare class QvacErrorAddonTTSGgml extends QvacErrorBase {
}
export declare const ERR_CODES: Readonly<{
    FAILED_TO_ACTIVATE: 13001;
    FAILED_TO_APPEND: 13002;
    FAILED_TO_GET_STATUS: 13003;
    FAILED_TO_PAUSE: 13004;
    FAILED_TO_CANCEL: 13005;
    FAILED_TO_DESTROY: 13006;
    FAILED_TO_UNLOAD: 13007;
    FAILED_TO_LOAD: 13008;
    FAILED_TO_RELOAD: 13009;
    FAILED_TO_STOP: 13010;
    JOB_ALREADY_RUNNING: 13011;
}>;
export {};
