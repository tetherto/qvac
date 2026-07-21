"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
exports.default = addonLogging;
module.exports = addonLogging;
