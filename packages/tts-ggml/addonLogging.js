"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseLogger = exports.setLogger = void 0;
function loadBinding() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from the host's prebuild package.
    return require("./binding");
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
const setLogger = (callback) => {
    loadBinding().setLogger(callback);
};
exports.setLogger = setLogger;
const releaseLogger = () => {
    loadBinding().releaseLogger();
};
exports.releaseLogger = releaseLogger;
const addonLogging = { setLogger: exports.setLogger, releaseLogger: exports.releaseLogger };
exports.default = addonLogging;
module.exports = addonLogging;
