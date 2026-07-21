type NativeLoggerCallback = (priority: number, message: string) => void;

export interface AddonLogging {
  setLogger: (callback: NativeLoggerCallback) => void;
  releaseLogger: () => void;
}

interface AddonLoggingBinding {
  setLogger: (callback: NativeLoggerCallback) => void;
  releaseLogger: () => void;
}

const addonLogging: AddonLogging = {
  get setLogger() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    return (require("./binding") as AddonLoggingBinding).setLogger;
  },
  get releaseLogger() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    return (require("./binding") as AddonLoggingBinding).releaseLogger;
  },
};

export default addonLogging;

module.exports = addonLogging;
