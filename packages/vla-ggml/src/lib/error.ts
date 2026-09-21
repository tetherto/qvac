/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
import QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */

const { QvacErrorBase, addCodes } = QvacError;

export class QvacErrorAddonVla extends QvacErrorBase {}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json") as {
  name: string;
  version: string;
};

// This library has error code range from 30001 to 31000
export const ERR_CODES = Object.freeze({
  FAILED_TO_LOAD_WEIGHTS: 30001,
  FAILED_TO_DESTROY: 30002,
  MODEL_NOT_FOUND: 30003,
  INVALID_CONFIG: 30004,
  MISSING_REQUIRED_PARAMETER: 30005,
  INVALID_INPUT: 30006,
  JOB_ALREADY_RUNNING: 30007,
  INSTANCE_NOT_INITIALIZED: 30008,
  MODEL_UNLOADED: 30009,
  INFERENCE_FAILED: 30010,
});

addCodes(
  {
    [ERR_CODES.FAILED_TO_LOAD_WEIGHTS]: {
      name: "FAILED_TO_LOAD_WEIGHTS",
      message: (message: string) => `Failed to load weights, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_DESTROY]: {
      name: "FAILED_TO_DESTROY",
      message: (message: string) =>
        `Failed to destroy instance, error: ${message}`,
    },
    [ERR_CODES.MODEL_NOT_FOUND]: {
      name: "MODEL_NOT_FOUND",
      message: (path: string) => `SmolVLA GGUF not found: ${path}`,
    },
    [ERR_CODES.INVALID_CONFIG]: {
      name: "INVALID_CONFIG",
      message: (message: string) => `Invalid configuration: ${message}`,
    },
    [ERR_CODES.MISSING_REQUIRED_PARAMETER]: {
      name: "MISSING_REQUIRED_PARAMETER",
      message: (paramName: string) => `Missing required parameter: ${paramName}`,
    },
    [ERR_CODES.INVALID_INPUT]: {
      name: "INVALID_INPUT",
      message: (message: string) => `Invalid input: ${message}`,
    },
    [ERR_CODES.JOB_ALREADY_RUNNING]: {
      name: "JOB_ALREADY_RUNNING",
      message: () =>
        "Cannot set new job: a job is already set or being processed",
    },
    [ERR_CODES.INSTANCE_NOT_INITIALIZED]: {
      name: "INSTANCE_NOT_INITIALIZED",
      message: () => "Addon not initialized. Call load() first.",
    },
    [ERR_CODES.MODEL_UNLOADED]: {
      name: "MODEL_UNLOADED",
      message: () => "Model was unloaded",
    },
    [ERR_CODES.INFERENCE_FAILED]: {
      name: "INFERENCE_FAILED",
      message: (message: string) => `Inference failed: ${message}`,
    },
  },
  {
    name,
    version,
  },
);
