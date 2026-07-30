import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
export declare class QvacErrorAddonMarian extends QvacErrorBase {
}
export declare const ERR_CODES: Readonly<{
    FAILED_TO_LOAD_WEIGHTS: 8001;
    FAILED_TO_CANCEL: 8002;
    FAILED_TO_APPEND: 8003;
    FAILED_TO_GET_STATUS: 8004;
    FAILED_TO_DESTROY: 8005;
    FAILED_TO_ACTIVATE: 8006;
    FAILED_TO_RESET: 8007;
    FAILED_TO_PAUSE: 8008;
    FAILED_TO_GET_BACKEND_NAME: 8009;
}>;
export {};
