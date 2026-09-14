export interface AddonLogging {
  setLogger(
    this: void,
    callback: (priority: number, message: string) => void,
  ): void;
  releaseLogger(this: void): void;
}

function loadBinding(): AddonLogging {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from the host's prebuild package.
  return require("./binding") as AddonLogging;
}

// The binding is loaded on first use, not at import.
//
// Since 0.9.0 the native addon ships in a separate, `os`/`cpu` filtered
// platform package, so requiring the binding throws on any host where that
// package was not installed — a `--omit=optional` or Yarn v1 install, a
// workspace checkout with no local build, or a bundle built for another
// platform. Consumers import this module to register a logging hook while
// wiring their plugins up, long before they ask for a model, and an eager
// require made that import fatal: it took the whole process down at startup
// rather than failing the one call that actually needs the addon.
export const setLogger: AddonLogging["setLogger"] = (callback) => {
  loadBinding().setLogger(callback);
};

export const releaseLogger: AddonLogging["releaseLogger"] = () => {
  loadBinding().releaseLogger();
};

const addonLogging: AddonLogging = { setLogger, releaseLogger };
export default addonLogging;

module.exports = addonLogging;
