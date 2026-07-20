"use strict";
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
module.exports = addonLogging;
