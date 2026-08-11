"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const processModule = require("bare-process");
/* eslint-enable @typescript-eslint/no-require-imports */
const process_internal_1 = require("./process-internal");
const process_1 = require("./process");
const process = processModule;
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
function finish(line) {
    writeOutcome((0, process_internal_1.runFitProcessLine)(line, fit));
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
