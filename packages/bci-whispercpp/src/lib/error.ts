/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
import QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */

const { QvacErrorBase, addCodes } = QvacError;

export class QvacErrorAddonBCI extends QvacErrorBase {}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return typeof err === "string" ? err : "unknown error";
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json") as {
  name: string;
  version: string;
};

// This library has error code range from 26001 to 27000.
// Ranges used elsewhere in the @qvac/error registry:
//   6001-6018  @qvac/transcription-whispercpp
//   7001-7011  @qvac/tts-onnx
//   8001-8008  @qvac/translation-nmtcpp
//   24001+     @qvac/transcription-parakeet
export const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 26001,
  FAILED_TO_CANCEL: 26002,
  FAILED_TO_APPEND: 26003,
  FAILED_TO_DESTROY: 26004,
  FAILED_TO_ACTIVATE: 26005,
  INVALID_NEURAL_INPUT: 26006,
  JOB_ALREADY_RUNNING: 26007,
  MODEL_NOT_LOADED: 26008,
  MODEL_FILE_NOT_FOUND: 26009,
  BUFFER_LIMIT_EXCEEDED: 26010,
  FAILED_TO_START_JOB: 26011,
  INVALID_CONFIG: 26012,
  EMBEDDER_WEIGHTS_INVALID: 26013,
  STREAM_ALREADY_ACTIVE: 26014,
  INVALID_STREAM_INPUT: 26015,
  INVALID_STREAM_HEADER: 26016,
  WINDOW_TOO_LARGE: 26017,
});

addCodes(
  {
    [ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
      name: "FAILED_TO_LOAD_WEIGHTS",
      message: (message: string) => `Failed to load weights, error: ${message}`,
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
    [ERR_CODES.INVALID_NEURAL_INPUT]: {
      name: "INVALID_NEURAL_INPUT",
      message: (message: string) => `Invalid neural signal input: ${message}`,
    },
    [ERR_CODES.JOB_ALREADY_RUNNING]: {
      name: "JOB_ALREADY_RUNNING",
      message: () =>
        "Cannot set new job: a job is already set or being processed",
    },
    [ERR_CODES.MODEL_NOT_LOADED]: {
      name: "MODEL_NOT_LOADED",
      message: () => "Model is not loaded",
    },
    [ERR_CODES.MODEL_FILE_NOT_FOUND]: {
      name: "MODEL_FILE_NOT_FOUND",
      message: (modelPath: string) => `Model file not found at: ${modelPath}`,
    },
    [ERR_CODES.BUFFER_LIMIT_EXCEEDED]: {
      name: "BUFFER_LIMIT_EXCEEDED",
      message: (limit: string | number) =>
        `Neural signal buffer exceeded limit of ${limit}`,
    },
    [ERR_CODES.FAILED_TO_START_JOB]: {
      name: "FAILED_TO_START_JOB",
      message: (message: string) =>
        `Failed to start inference job, error: ${message}`,
    },
    [ERR_CODES.INVALID_CONFIG]: {
      name: "INVALID_CONFIG",
      message: (message: string) => `Invalid BCI configuration: ${message}`,
    },
    [ERR_CODES.EMBEDDER_WEIGHTS_INVALID]: {
      name: "EMBEDDER_WEIGHTS_INVALID",
      message: (message: string) =>
        `BCI embedder weights are invalid: ${message}`,
    },
    [ERR_CODES.STREAM_ALREADY_ACTIVE]: {
      name: "STREAM_ALREADY_ACTIVE",
      message: () => "A streaming transcription is already in progress",
    },
    [ERR_CODES.INVALID_STREAM_INPUT]: {
      name: "INVALID_STREAM_INPUT",
      message: (message: string) =>
        `Invalid neural signal stream input: ${message}`,
    },
    [ERR_CODES.INVALID_STREAM_HEADER]: {
      name: "INVALID_STREAM_HEADER",
      message: (message: string) =>
        `Invalid neural signal stream header: ${message}`,
    },
    [ERR_CODES.WINDOW_TOO_LARGE]: {
      name: "WINDOW_TOO_LARGE",
      message: (limit: string | number) =>
        `Stream window size exceeds encoder capacity of ${limit} timesteps`,
    },
  },
  {
    name,
    version,
  },
);
