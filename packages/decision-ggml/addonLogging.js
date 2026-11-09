"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding");
const addonLogging = {
    setLogger: binding.setLogger,
    releaseLogger: binding.releaseLogger,
};
exports.default = addonLogging;
module.exports = addonLogging;
