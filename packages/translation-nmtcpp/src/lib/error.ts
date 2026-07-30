/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
import QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */

const { QvacErrorBase, addCodes } = QvacError;

export class QvacErrorAddonMarian extends QvacErrorBase {}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json") as {
  name: string;
  version: string;
};

// This library has error code range from 8001 to 9000
export const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 8001,
  FAILED_TO_CANCEL: 8002,
  FAILED_TO_APPEND: 8003,
  FAILED_TO_GET_STATUS: 8004,
  FAILED_TO_DESTROY: 8005,
  FAILED_TO_ACTIVATE: 8006,
  FAILED_TO_RESET: 8007,
  FAILED_TO_PAUSE: 8008,
  FAILED_TO_GET_BACKEND_NAME: 8009,
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
    [ERR_CODES.FAILED_TO_GET_STATUS]: {
      name: "FAILED_TO_GET_STATUS",
      message: (message: string) => `Failed to get addon status, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_DESTROY]: {
      name: "FAILED_TO_DESTROY",
      message: (message: string) =>
        `Failed to destroy instance, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_ACTIVATE]: {
      name: "FAILED_TO_ACTIVATE",
      message: (message: string) => `Failed to activate model, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_RESET]: {
      name: "FAILED_TO_RESET",
      message: (message: string) =>
        `Failed to reset model state, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_PAUSE]: {
      name: "FAILED_TO_PAUSE",
      message: (message: string) => `Failed to pause inference, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_GET_BACKEND_NAME]: {
      name: "FAILED_TO_GET_BACKEND_NAME",
      message: (message: string) =>
        `Failed to get active backend name, error: ${message}`,
    },
  },
  {
    name,
    version,
  },
);
