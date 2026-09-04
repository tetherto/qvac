"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRuntimeConfig = resolveRuntimeConfig;
const fs = require("bare-fs");
const os = require("bare-os");
const path = require("bare-path");
__exportStar(require("./protocol"), exports);
__exportStar(require("./worker-manager"), exports);
function requireAbsoluteDirectory(value, name) {
    if (!path.isAbsolute(value)) {
        throw new TypeError(`${name} must be an absolute path`);
    }
    if (!fs.statSync(value).isDirectory()) {
        throw new TypeError(`${name} must be an existing directory`);
    }
    return value;
}
function resolveRuntimeConfig(options) {
    if (os.platform() === 'android' || os.platform() === 'ios') {
        throw new Error('MiniMax-Music3 Diffusers requires a desktop CUDA runtime');
    }
    const modelDir = requireAbsoluteDirectory(options.modelDir, 'modelDir');
    const cacheDir = options.cacheDir === undefined
        ? undefined
        : requireAbsoluteDirectory(options.cacheDir, 'cacheDir');
    return { modelDir, cacheDir, device: 'cuda', torchDtype: 'bfloat16' };
}
