import QvacError = require("@qvac/error");
declare const QvacErrorBase: typeof QvacError.QvacErrorBase;
type QvacErrorOptions = ConstructorParameters<typeof QvacErrorBase>[0];
export declare class QvacErrorAddonASRGgml extends QvacErrorBase {
    constructor(options?: QvacErrorOptions | number);
}
/**
 * Public error-code map. Shared verbs are canonical in the historical
 * whisper 6xxx range; parakeet-only names keep their historical 24xxx
 * numbers; new asr-ggml codes are appended in the 6xxx range.
 */
export declare const ERR_CODES: Readonly<{
    FAILED_TO_LOAD_WEIGHTS: 6001;
    FAILED_TO_CANCEL: 6002;
    FAILED_TO_APPEND: 6003;
    FAILED_TO_GET_STATUS: 6004;
    FAILED_TO_DESTROY: 6005;
    FAILED_TO_ACTIVATE: 6006;
    FAILED_TO_RESET: 6007;
    FAILED_TO_PAUSE: 6008;
    VAD_MODEL_REQUIRED: 6009;
    JOB_ALREADY_RUNNING: 6010;
    INVALID_AUDIO_INPUT: 6011;
    FAILED_TO_START_STREAMING: 6012;
    FAILED_TO_APPEND_STREAMING: 6013;
    FAILED_TO_END_STREAMING: 6014;
    BUFFER_LIMIT_EXCEEDED: 6015;
    FAILED_TO_STOP: 6016;
    MODEL_REQUIRED: 6017;
    VAD_MODEL_NOT_FOUND: 6018;
    MODEL_NOT_FOUND: 24009;
    INVALID_AUDIO_FORMAT: 24010;
    INVALID_CONFIG: 24015;
    INSTANCE_DESTROYED: 24018;
    JOB_CANCELLED: 24019;
    NOT_SUPPORTED: 6019;
    STREAMING_SESSION_ACTIVE: 6020;
    INVALID_ENGINE: 6021;
}>;
/**
 * Internal, engine-scoped map keeping parakeet's historically-emitted
 * numeric codes stable. Used ONLY by `engines/parakeet/{driver,parakeet}.ts`
 * so a parakeet `FAILED_TO_APPEND` still surfaces as 24003. Not part of the
 * package's public type surface.
 */
export declare const ERR_CODES_PARAKEET: Readonly<{
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
/**
 * Registers this package's codes, tolerating the one collision the merge
 * created.
 *
 * 6001–6018 used to be owned by `@qvac/transcription-whispercpp` and
 * 24001–24019 by `@qvac/transcription-parakeet`. `@qvac/error`'s duplicate
 * guard is keyed on the *owning package name*, so the rename alone is enough
 * to collide: any process that loads a pre-merge ASR package **and**
 * `@qvac/asr-ggml` against one hoisted `@qvac/error` would throw
 * ERROR_CODE_ALREADY_EXISTS at module scope, i.e. `require('@qvac/asr-ggml')`
 * would crash. That happens during the release-step flip (the co-load smoke
 * addon list transiently carries old and new names) and for any consumer that
 * upgrades one ASR dependency at a time.
 *
 * The happy path is unchanged — a single `addCodes` with package info, so the
 * same-package version-upgrade behavior in `@qvac/error` still applies. Only
 * when that throws do we re-register the subset nobody owns yet. Codes
 * already claimed keep the other package's definition, whose `name` and
 * `message` text is the text this package ships: both historical tables were
 * ported verbatim. `addCodes` registers codes in map order and throws on the
 * first conflict, so the codes it accepted before throwing are already in
 * place with this package's definitions; the retry only has to cover the rest.
 *
 * Exported (with an injectable `pkg`) so the unit suite can exercise the
 * collision path without a second ASR package installed.
 */
export declare function registerCodes(codes: QvacError.ErrorCodesMap, pkg?: {
    name: string;
    version: string;
}): void;
export {};
