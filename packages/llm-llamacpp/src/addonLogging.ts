/* eslint-disable @typescript-eslint/unbound-method -- the native log hooks never read `this`. */

export interface AddonLogging {
  setLogger(callback: (priority: number, message: string) => void): void;
  releaseLogger(): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding") as AddonLogging;

const addonLogging: AddonLogging = {
  setLogger: binding.setLogger,
  releaseLogger: binding.releaseLogger,
};

// ESM named imports need the top-level `exports.X =` form these emit.
export const setLogger = addonLogging.setLogger;
export const releaseLogger = addonLogging.releaseLogger;

export default addonLogging;

module.exports = addonLogging;
