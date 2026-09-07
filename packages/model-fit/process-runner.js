"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const processModule = require("bare-process");
/* eslint-enable @typescript-eslint/no-require-imports */
const process_internal_1 = require("./process-internal");
const process_1 = require("./process");
const process = processModule;
// Duplicate of index.ts resolveBackendsDir: this runner must not import
// `./index` at load time because that would load the native binding. The v2
// llamaConfigFit path also cannot go through fitParams().
function resolveBackendsDir() {
    try {
        const fabricPkg = require.resolve('@qvac/fabric/package');
        const fabricPrebuilds = path.join(path.dirname(fabricPkg), 'prebuilds');
        if (fs.statSync(fabricPrebuilds).isDirectory())
            return fabricPrebuilds;
    }
    catch {
        // Mobile worklets cannot resolve the @qvac/fabric package tree.
    }
    try {
        const packaged = path.join(__dirname, 'prebuilds');
        return fs.statSync(packaged).isDirectory() ? packaged : undefined;
    }
    catch {
        return undefined;
    }
}
function exitAfterWriteError(error) {
    process.stderr.write(`model-fit process runner failed to write its response: ${error.message}\n`, () => {
        process.exit(2);
    });
}
function writeOutcome(outcome) {
    // One shot: stop reading before replying, so a still-open stdin cannot hold
    // the child open once the response has been flushed.
    process.stdin.pause();
    process.stdout.write(outcome.responseLine, (error) => {
        if (error !== null) {
            exitAfterWriteError(error);
            return;
        }
        process.exit(outcome.exitCode);
    });
}
// Deliberately not a top-level import: loading the addon registers the ggml
// backends, which is the very work this boundary exists to keep disposable. A
// malformed or oversized request is answered without ever touching native code.
function fit(config) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    return require('./index').fitParams(config);
}
function fitLlama(...args) {
    const [loadKind, config] = args;
    // `./binding-internal`, not `./binding`: the raw load-config fitter is not
    // public API, and `./binding.js` is a public export.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is disposable here.
    const binding = require('./binding-internal');
    let resolved = config;
    if (config.backendsDir === undefined) {
        const packaged = resolveBackendsDir();
        if (packaged !== undefined) {
            resolved = { ...config, backendsDir: packaged };
        }
    }
    return binding.llamaConfigFit({ loadKind, ...resolved });
}
function finish(line) {
    writeOutcome((0, process_internal_1.runFitProcessLine)(line, fit, fitLlama));
}
let input = '';
let finished = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    if (finished)
        return;
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > process_1.FIT_PROCESS_MAX_REQUEST_BYTES) {
        finished = true;
        finish(input);
        return;
    }
    const newline = input.indexOf('\n');
    if (newline === -1)
        return;
    finished = true;
    finish(input.slice(0, newline));
});
process.stdin.on('end', () => {
    if (finished)
        return;
    finished = true;
    finish(input);
});
// A parent that dies mid-request breaks the pipe; diagnose and exit here so the
// failure stays inside the disposable child instead of crashing it unexplained.
process.stdin.on('error', (error) => {
    if (finished)
        return;
    finished = true;
    process.stderr.write(`model-fit process runner failed to read its request: ${error.message}\n`, () => {
        process.exit(2);
    });
});
process.stdin.resume();
