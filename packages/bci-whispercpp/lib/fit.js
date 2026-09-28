"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
const bare_path_1 = __importDefault(require("bare-path"));
/** Where the CMake build stages the per-arch backends, as `index.ts` resolves it. */
const PREBUILDS_DIR = bare_path_1.default.join(__dirname, '..', 'prebuilds');
/**
 * Projects a BCI load against the memory free right now, reading model
 * metadata and never weight data.
 *
 * Covers the whisper half of the load. A model the fitter cannot read comes
 * back as `status: "error"`; a broken request, or a host with no native
 * binding, throws.
 *
 * The backend directory defaults to the one a real load uses. The native side
 * registers backends once per process, so a fit that let it fall back to the
 * default search path would fix that path for every later load too.
 */
function assessFit(request) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require('../binding.js');
    return binding.assessFit({
        ...request,
        backendsDir: typeof request.backendsDir === 'string' && request.backendsDir.length > 0
            ? request.backendsDir
            : PREBUILDS_DIR
    });
}
