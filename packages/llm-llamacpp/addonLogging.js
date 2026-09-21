"use strict";
/* eslint-disable @typescript-eslint/unbound-method -- the native log hooks never read `this`. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseLogger = exports.setLogger = void 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding");
const addonLogging = {
    setLogger: binding.setLogger,
    releaseLogger: binding.releaseLogger,
};
// ESM named imports need the top-level `exports.X =` form these emit.
exports.setLogger = addonLogging.setLogger;
exports.releaseLogger = addonLogging.releaseLogger;
exports.default = addonLogging;
module.exports = addonLogging;
