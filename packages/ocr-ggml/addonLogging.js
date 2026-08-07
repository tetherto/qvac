"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseLogger = exports.setLogger = void 0;
const addonLogging = {
    get setLogger() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        return require("./binding").setLogger;
    },
    get releaseLogger() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
        return require("./binding").releaseLogger;
    },
};
// ESM named imports need the top-level `exports.X =` form these emit. They
// delegate rather than capture, so the binding stays resolved on first call.
const setLogger = (callback) => addonLogging.setLogger(callback);
exports.setLogger = setLogger;
const releaseLogger = () => addonLogging.releaseLogger();
exports.releaseLogger = releaseLogger;
exports.default = addonLogging;
module.exports = addonLogging;
