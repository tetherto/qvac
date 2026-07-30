"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseLogger = exports.setLogger = void 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding");
const addonLogging = {
    setLogger: binding.setLogger,
    releaseLogger: binding.releaseLogger,
};
// Required for ESM named imports: cjs-module-lexer only detects top-level
// `exports.X =` assignments; the bindings resolve against `module.exports` below.
exports.setLogger = addonLogging.setLogger;
exports.releaseLogger = addonLogging.releaseLogger;
exports.default = addonLogging;
module.exports = addonLogging;
