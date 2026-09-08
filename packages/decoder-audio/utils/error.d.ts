import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
export declare class QvacErrorDecoderAudio extends QvacErrorBase {
}
export declare const ERR_CODES: Readonly<{
    FAILED_TO_LOAD_WEIGHTS: 11001;
    FAILED_TO_ACTIVATE: 11002;
    FAILED_TO_PAUSE: 11003;
    FAILED_TO_CANCEL: 11004;
    FAILED_TO_APPEND: 11005;
    FAILED_TO_GET_STATUS: 11006;
    FAILED_TO_DESTROY: 11007;
    BUFFER_SIZE_TOO_SMALL: 11008;
    UNSUPPORTED_AUDIO_FORMAT: 11009;
    DECODER_NOT_LOADED: 11010;
    STREAM_INDEX_OUT_OF_BOUNDS: 11011;
    JOB_CANCELLED: 11012;
}>;
export {};
