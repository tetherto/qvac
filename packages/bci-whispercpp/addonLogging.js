"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseLogger = exports.setLogger = void 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require("./binding");
exports.setLogger = binding.setLogger;
exports.releaseLogger = binding.releaseLogger;
