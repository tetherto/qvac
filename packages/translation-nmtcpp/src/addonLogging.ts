type NativeLoggerCallback = (priority: number, message: string) => void;

export interface AddonLogging {
  setLogger: (callback: NativeLoggerCallback) => void;
  releaseLogger: () => void;
}

interface AddonLoggingBinding {
  setLogger: (callback: NativeLoggerCallback) => void;
  releaseLogger: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding") as AddonLoggingBinding;

const addonLogging: AddonLogging = {
  setLogger: binding.setLogger,
  releaseLogger: binding.releaseLogger,
};

// Required for ESM named imports: cjs-module-lexer only detects top-level
// `exports.X =` assignments; the bindings resolve against `module.exports` below.
export const setLogger = addonLogging.setLogger;
export const releaseLogger = addonLogging.releaseLogger;

export default addonLogging;

module.exports = addonLogging;
