/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
import QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */

const { QvacErrorBase, addCodes, isCodeRegistered, INTERNAL_ERROR_CODES } =
  QvacError;

type QvacErrorOptions = ConstructorParameters<typeof QvacErrorBase>[0];

export class QvacErrorAddonASRGgml extends QvacErrorBase {
  constructor(options?: QvacErrorOptions | number) {
    super(typeof options === "number" ? { code: options } : options);
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json") as {
  name: string;
  version: string;
};

/**
 * Public error-code map. Shared verbs are canonical in the historical
 * whisper 6xxx range; parakeet-only names keep their historical 24xxx
 * numbers; new asr-ggml codes are appended in the 6xxx range.
 */
export const ERR_CODES = Object.freeze({
  // shared verbs — canonical 6xxx
  FAILED_TO_LOAD_WEIGHTS: 6001,
  FAILED_TO_CANCEL: 6002,
  FAILED_TO_APPEND: 6003,
  FAILED_TO_GET_STATUS: 6004,
  FAILED_TO_DESTROY: 6005,
  FAILED_TO_ACTIVATE: 6006,
  FAILED_TO_RESET: 6007,
  FAILED_TO_PAUSE: 6008,
  VAD_MODEL_REQUIRED: 6009,
  JOB_ALREADY_RUNNING: 6010,
  INVALID_AUDIO_INPUT: 6011,
  FAILED_TO_START_STREAMING: 6012,
  FAILED_TO_APPEND_STREAMING: 6013,
  FAILED_TO_END_STREAMING: 6014,
  BUFFER_LIMIT_EXCEEDED: 6015,
  FAILED_TO_STOP: 6016,
  MODEL_REQUIRED: 6017,
  VAD_MODEL_NOT_FOUND: 6018,
  // parakeet-only — numbers preserved
  MODEL_NOT_FOUND: 24009,
  INVALID_AUDIO_FORMAT: 24010,
  INVALID_CONFIG: 24015,
  INSTANCE_DESTROYED: 24018,
  JOB_CANCELLED: 24019,
  // new (asr-ggml)
  NOT_SUPPORTED: 6019,
  STREAMING_SESSION_ACTIVE: 6020,
  INVALID_ENGINE: 6021,
});

/**
 * Internal, engine-scoped map keeping parakeet's historically-emitted
 * numeric codes stable. Used ONLY by `engines/parakeet/{driver,parakeet}.ts`
 * so a parakeet `FAILED_TO_APPEND` still surfaces as 24003. Not part of the
 * package's public type surface.
 */
export const ERR_CODES_PARAKEET = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 24001,
  FAILED_TO_CANCEL: 24002,
  FAILED_TO_APPEND: 24003,
  FAILED_TO_GET_STATUS: 24004,
  FAILED_TO_DESTROY: 24005,
  FAILED_TO_ACTIVATE: 24006,
  FAILED_TO_RESET: 24007,
  FAILED_TO_PAUSE: 24008,
  MODEL_NOT_FOUND: 24009,
  INVALID_AUDIO_FORMAT: 24010,
  INVALID_CONFIG: 24015,
  JOB_ALREADY_RUNNING: 24016,
  BUFFER_LIMIT_EXCEEDED: 24017,
  INSTANCE_DESTROYED: 24018,
  JOB_CANCELLED: 24019,
});

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
export function registerCodes(
  codes: QvacError.ErrorCodesMap,
  pkg: { name: string; version: string } = { name, version },
): void {
  try {
    addCodes(codes, pkg);
    return;
  } catch (err) {
    const failureCode = (err as { code?: number }).code;
    if (failureCode !== INTERNAL_ERROR_CODES.ERROR_CODE_ALREADY_EXISTS) {
      throw err;
    }
  }
  const unowned: QvacError.ErrorCodesMap = {};
  for (const [numeric, definition] of Object.entries(codes)) {
    const numericCode = Number(numeric);
    if (!isCodeRegistered(numericCode)) unowned[numericCode] = definition;
  }
  if (Object.keys(unowned).length > 0) {
    addCodes(unowned, pkg);
  }
}

// One registration covering the full union of both historical tables
// (whisper 6001–6018 and parakeet 24001–24019, message functions verbatim)
// plus the new asr-ggml codes, so every historical numeric code stays
// resolvable under the unified package.
registerCodes(
  {
    // --- whisper-historical 6xxx range (canonical for shared verbs) ---
    [ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
      name: "FAILED_TO_LOAD_WEIGHTS",
      message: (message: string) =>
        `Failed to load weights, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_CANCEL]: {
      name: "FAILED_TO_CANCEL",
      message: (message: string) =>
        `Failed to cancel inference, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_APPEND]: {
      name: "FAILED_TO_APPEND",
      message: (message: string) =>
        `Failed to append data to processing queue, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_GET_STATUS]: {
      name: "FAILED_TO_GET_STATUS",
      message: (message: string) =>
        `Failed to get addon status, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_DESTROY]: {
      name: "FAILED_TO_DESTROY",
      message: (message: string) =>
        `Failed to destroy instance, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_ACTIVATE]: {
      name: "FAILED_TO_ACTIVATE",
      message: (message: string) =>
        `Failed to activate model, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_RESET]: {
      name: "FAILED_TO_RESET",
      message: (message: string) =>
        `Failed to reset model state, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_PAUSE]: {
      name: "FAILED_TO_PAUSE",
      message: (message: string) =>
        `Failed to pause inference, error: ${message}`,
    },
    [ERR_CODES.VAD_MODEL_REQUIRED]: {
      name: "VAD_MODEL_REQUIRED",
      message: () => "VAD model name is required for Whisper transcription",
    },
    [ERR_CODES.JOB_ALREADY_RUNNING]: {
      name: "JOB_ALREADY_RUNNING",
      message: () =>
        "Cannot set new job: a job is already set or being processed",
    },
    [ERR_CODES.INVALID_AUDIO_INPUT]: {
      name: "INVALID_AUDIO_INPUT",
      message: (message: string) => `Invalid audio input: ${message}`,
    },
    [ERR_CODES.FAILED_TO_START_STREAMING]: {
      name: "FAILED_TO_START_STREAMING",
      message: (message: string) =>
        `Failed to start streaming session: ${message}`,
    },
    [ERR_CODES.FAILED_TO_APPEND_STREAMING]: {
      name: "FAILED_TO_APPEND_STREAMING",
      message: (message: string) =>
        `Failed to append streaming audio: ${message}`,
    },
    [ERR_CODES.FAILED_TO_END_STREAMING]: {
      name: "FAILED_TO_END_STREAMING",
      message: (message: string) =>
        `Failed to end streaming session: ${message}`,
    },
    [ERR_CODES.BUFFER_LIMIT_EXCEEDED]: {
      name: "BUFFER_LIMIT_EXCEEDED",
      message: (message: string) =>
        `Audio buffer size limit exceeded: ${message}`,
    },
    [ERR_CODES.FAILED_TO_STOP]: {
      name: "FAILED_TO_STOP",
      message: (message: string) =>
        `Failed to stop addon, error: ${message}`,
    },
    [ERR_CODES.MODEL_REQUIRED]: {
      name: "MODEL_REQUIRED",
      message: (message: string) => `Model is required: ${message}`,
    },
    [ERR_CODES.VAD_MODEL_NOT_FOUND]: {
      name: "VAD_MODEL_NOT_FOUND",
      message: (message: string) => `VAD model file not found: ${message}`,
    },
    // --- new asr-ggml codes ---
    [ERR_CODES.NOT_SUPPORTED]: {
      name: "NOT_SUPPORTED",
      message: (message: string) => `Operation not supported: ${message}`,
    },
    [ERR_CODES.STREAMING_SESSION_ACTIVE]: {
      name: "STREAMING_SESSION_ACTIVE",
      message: (message: string) =>
        `A streaming session is active: ${message}`,
    },
    [ERR_CODES.INVALID_ENGINE]: {
      name: "INVALID_ENGINE",
      message: (message: string) =>
        `Unknown or undetectable ASR engine: ${message}`,
    },
    // --- parakeet-historical 24xxx range ---
    [ERR_CODES_PARAKEET.FAILED_TO_LOAD_WEIGHTS]: {
      name: "FAILED_TO_LOAD_WEIGHTS",
      message: (message: string) =>
        `Failed to load weights, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.FAILED_TO_CANCEL]: {
      name: "FAILED_TO_CANCEL",
      message: (message: string) =>
        `Failed to cancel inference, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.FAILED_TO_APPEND]: {
      name: "FAILED_TO_APPEND",
      message: (message: string) =>
        `Failed to append audio data to processing queue, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.FAILED_TO_GET_STATUS]: {
      name: "FAILED_TO_GET_STATUS",
      message: (message: string) =>
        `Failed to get addon status, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.FAILED_TO_DESTROY]: {
      name: "FAILED_TO_DESTROY",
      message: (message: string) =>
        `Failed to destroy instance, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.FAILED_TO_ACTIVATE]: {
      name: "FAILED_TO_ACTIVATE",
      message: (message: string) =>
        `Failed to activate model, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.FAILED_TO_RESET]: {
      name: "FAILED_TO_RESET",
      message: (message: string) =>
        `Failed to reset model state, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.FAILED_TO_PAUSE]: {
      name: "FAILED_TO_PAUSE",
      message: (message: string) =>
        `Failed to pause inference, error: ${message}`,
    },
    [ERR_CODES_PARAKEET.MODEL_NOT_FOUND]: {
      name: "MODEL_NOT_FOUND",
      message: (modelPath: string) => `Model not found at path: ${modelPath}`,
    },
    [ERR_CODES_PARAKEET.INVALID_AUDIO_FORMAT]: {
      name: "INVALID_AUDIO_FORMAT",
      message: (format: string) =>
        `Invalid audio format: ${format}. Expected 16kHz mono audio.`,
    },
    [ERR_CODES_PARAKEET.INVALID_CONFIG]: {
      name: "INVALID_CONFIG",
      message: (message: string) => `Invalid configuration: ${message}`,
    },
    [ERR_CODES_PARAKEET.JOB_ALREADY_RUNNING]: {
      name: "JOB_ALREADY_RUNNING",
      message: () =>
        "Cannot set new job: a job is already set or being processed",
    },
    [ERR_CODES_PARAKEET.BUFFER_LIMIT_EXCEEDED]: {
      name: "BUFFER_LIMIT_EXCEEDED",
      message: (message: string) =>
        `Audio buffer size limit exceeded: ${message}`,
    },
    [ERR_CODES_PARAKEET.INSTANCE_DESTROYED]: {
      name: "INSTANCE_DESTROYED",
      message: () => "Cannot load: instance has been destroyed",
    },
    [ERR_CODES_PARAKEET.JOB_CANCELLED]: {
      name: "JOB_CANCELLED",
      message: () => "Job cancelled",
    },
  },
);
