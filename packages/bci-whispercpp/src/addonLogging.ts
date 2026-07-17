type NativeLoggerCallback = (priority: number, message: string) => void;

interface AddonLoggingBinding {
  setLogger: (callback: NativeLoggerCallback) => void;
  releaseLogger: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding") as AddonLoggingBinding;

export const setLogger = binding.setLogger;
export const releaseLogger = binding.releaseLogger;
