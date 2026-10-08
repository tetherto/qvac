"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveBackendsDir = resolveBackendsDir;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and fabric expose CommonJS export shapes. */
const path = require("bare-path");
const fs = require("bare-fs");
const fabricBackends = require("@qvac/fabric/backends");
/* eslint-enable @typescript-eslint/no-require-imports */
// The ggml backends ship beside @qvac/fabric on desktop. Mobile bundles stage
// them beside this addon because the package tree is not resolved at runtime.
function resolveBackendsDir() {
    const fabricRoot = fabricBackends.resolveBackendsDir();
    if (fabricRoot !== null && fs.existsSync(fabricRoot))
        return fabricRoot;
    return path.join(__dirname, "..", "prebuilds");
}
