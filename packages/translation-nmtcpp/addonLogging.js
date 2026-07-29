"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseLogger = exports.setLogger = void 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding");
const addonLogging = {
    setLogger: binding.setLogger,
    releaseLogger: binding.releaseLogger,
};
// Named exports keep `setLogger`/`releaseLogger` statically discoverable by
// cjs-module-lexer (Node's and Bare's CJS→ESM interop), so ESM named imports
// link. The trailing `module.exports =` override below discards these
// `exports.X` slots at runtime, but named import bindings resolve against the
// final `module.exports` object — which carries the same two functions.
exports.setLogger = addonLogging.setLogger;
exports.releaseLogger = addonLogging.releaseLogger;
exports.default = addonLogging;
module.exports = addonLogging;
