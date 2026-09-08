/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
import QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */

const { QvacErrorBase, addCodes } = QvacError;

export class QvacErrorDecoderAudio extends QvacErrorBase {}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json") as {
  name: string;
  version: string;
};

// This library has error code range from 11,001 to 12,000
export const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 11001,
  FAILED_TO_ACTIVATE: 11002,
  FAILED_TO_PAUSE: 11003,
  FAILED_TO_CANCEL: 11004,
  FAILED_TO_APPEND: 11005,
  FAILED_TO_GET_STATUS: 11006,
  FAILED_TO_DESTROY: 11007,
  BUFFER_SIZE_TOO_SMALL: 11008,
  UNSUPPORTED_AUDIO_FORMAT: 11009,
  DECODER_NOT_LOADED: 11010,
  STREAM_INDEX_OUT_OF_BOUNDS: 11011,
  JOB_CANCELLED: 11012,
});

addCodes(
  {
    [ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
      name: "FAILED_TO_LOAD_WEIGHTS",
      message: (message: string) => `Failed to load weights, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_ACTIVATE]: {
      name: "FAILED_TO_ACTIVATE",
      message: (message: string) => `Failed to activate model, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_PAUSE]: {
      name: "FAILED_TO_PAUSE",
      message: (message: string) => `Failed to pause inference, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_CANCEL]: {
      name: "FAILED_TO_CANCEL",
      message: (message: string) => `Failed to cancel inference, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_APPEND]: {
      name: "FAILED_TO_APPEND",
      message: (message: string) =>
        `Failed to append data to processing queue, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_GET_STATUS]: {
      name: "FAILED_TO_GET_STATUS",
      message: (message: string) => `Failed to get decoder status, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_DESTROY]: {
      name: "FAILED_TO_DESTROY",
      message: (message: string) => `Failed to destroy instance, error: ${message}`,
    },
    [ERR_CODES.BUFFER_SIZE_TOO_SMALL]: {
      name: "BUFFER_SIZE_TOO_SMALL",
      message: "Target buffer size is too small",
    },
    [ERR_CODES.UNSUPPORTED_AUDIO_FORMAT]: {
      name: "UNSUPPORTED_AUDIO_FORMAT",
      message: (format: string) => `Unsupported audio format: ${format}`,
    },
    [ERR_CODES.DECODER_NOT_LOADED]: {
      name: "DECODER_NOT_LOADED",
      message: "Decoder not loaded. Call load() first.",
    },
    [ERR_CODES.STREAM_INDEX_OUT_OF_BOUNDS]: {
      name: "STREAM_INDEX_OUT_OF_BOUNDS",
      message: (index: number) => `Stream index out of bounds: ${index}`,
    },
    [ERR_CODES.JOB_CANCELLED]: {
      name: "JOB_CANCELLED",
      message: "Decoder job cancelled",
    },
  },
  { name, version },
);
