/* eslint-disable @typescript-eslint/no-require-imports -- @qvac/error exposes a CommonJS export shape. */
import QvacError = require("@qvac/error");
/* eslint-enable @typescript-eslint/no-require-imports */

const { QvacErrorBase, addCodes } = QvacError;

export class QvacErrorAddonTTSGgml extends QvacErrorBase {}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
const { name, version } = require("../package.json") as {
  name: string;
  version: string;
};

// This library has error code range from 13001 to 14000.
export const ERR_CODES = Object.freeze({
  FAILED_TO_ACTIVATE: 13001,
  FAILED_TO_APPEND: 13002,
  FAILED_TO_GET_STATUS: 13003,
  FAILED_TO_PAUSE: 13004,
  FAILED_TO_CANCEL: 13005,
  FAILED_TO_DESTROY: 13006,
  FAILED_TO_UNLOAD: 13007,
  FAILED_TO_LOAD: 13008,
  FAILED_TO_RELOAD: 13009,
  FAILED_TO_STOP: 13010,
  JOB_ALREADY_RUNNING: 13011,
});

addCodes(
  {
    [ERR_CODES.FAILED_TO_ACTIVATE]: {
      name: "FAILED_TO_ACTIVATE",
      message: (message: string) =>
        `Failed to activate model, error: ${message}`,
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
    [ERR_CODES.FAILED_TO_PAUSE]: {
      name: "FAILED_TO_PAUSE",
      message: (message: string) =>
        `Failed to pause inference, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_CANCEL]: {
      name: "FAILED_TO_CANCEL",
      message: (message: string) =>
        `Failed to cancel inference, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_DESTROY]: {
      name: "FAILED_TO_DESTROY",
      message: (message: string) =>
        `Failed to destroy instance, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_UNLOAD]: {
      name: "FAILED_TO_UNLOAD",
      message: (message: string) =>
        `Failed to unload model, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_LOAD]: {
      name: "FAILED_TO_LOAD",
      message: (message: string) =>
        `Failed to load model, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_RELOAD]: {
      name: "FAILED_TO_RELOAD",
      message: (message: string) =>
        `Failed to reload model, error: ${message}`,
    },
    [ERR_CODES.FAILED_TO_STOP]: {
      name: "FAILED_TO_STOP",
      message: (message: string) =>
        `Failed to stop inference, error: ${message}`,
    },
    [ERR_CODES.JOB_ALREADY_RUNNING]: {
      name: "JOB_ALREADY_RUNNING",
      message: () =>
        "Cannot set new job: a job is already set or being processed",
    },
  },
  { name, version },
);
