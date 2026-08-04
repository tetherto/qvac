export interface AddonLogging {
  setLogger(
    this: void,
    callback: (priority: number, message: string) => void,
  ): void;
  releaseLogger(this: void): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding") as AddonLogging;

export const setLogger = binding.setLogger;
export const releaseLogger = binding.releaseLogger;

const addonLogging: AddonLogging = { setLogger, releaseLogger };
export default addonLogging;

module.exports = addonLogging;
