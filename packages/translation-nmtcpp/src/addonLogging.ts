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

// Named exports keep `setLogger`/`releaseLogger` statically discoverable by
// cjs-module-lexer (Node's and Bare's CJS→ESM interop), so ESM named imports
// link. The trailing `module.exports =` override below discards these
// `exports.X` slots at runtime, but named import bindings resolve against the
// final `module.exports` object — which carries the same two functions.
export const setLogger = addonLogging.setLogger;
export const releaseLogger = addonLogging.releaseLogger;

export default addonLogging;

module.exports = addonLogging;
