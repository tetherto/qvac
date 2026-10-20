"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessFit = assessFit;
/**
 * Projects a BCI load against the memory free right now, reading model
 * metadata and never weight data.
 *
 * Covers the whisper model and the embedder, from the files or from the
 * registry's weightless descriptions of them. A model or embedder the fitter
 * cannot read resolves to `status: "error"`; a broken request, or a host
 * with no native binding, rejects. Concurrent calls run one at a time.
 *
 * Unset, the backend directory is the one a real load uses, next to the loaded
 * module. The native side registers backends once per process, so the
 * directory a fit scans is the one every later load gets too.
 */
async function assessFit(request) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the native binding loads on first use.
    const binding = require('../binding.js');
    return await binding.assessFit(request);
}
