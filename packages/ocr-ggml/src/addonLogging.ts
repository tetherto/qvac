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

// ESM named imports need the top-level `exports.X =` form these emit. They
// delegate rather than capture, so the binding stays resolved on first call.
export const setLogger: AddonLogging["setLogger"] = (callback) =>
  addonLogging.setLogger(callback);
export const releaseLogger: AddonLogging["releaseLogger"] = () =>
  addonLogging.releaseLogger();

export default addonLogging;

module.exports = addonLogging;
