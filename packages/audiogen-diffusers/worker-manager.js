"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MiniMaxDiffusersWorker = void 0;
const fs = require("bare-fs");
const path = require("bare-path");
const bare_subprocess_1 = require("bare-subprocess");
const protocol_1 = require("./protocol");
class MiniMaxDiffusersWorker {
    pythonPath;
    onEvent;
    child = null;
    pending = '';
    constructor(pythonPath, onEvent) {
        this.pythonPath = pythonPath;
        this.onEvent = onEvent;
        if (!path.isAbsolute(pythonPath) || !fs.existsSync(pythonPath)) {
            throw new TypeError('pythonPath must be an existing absolute path');
        }
    }
    start() {
        if (this.child !== null)
            return;
        const child = (0, bare_subprocess_1.spawn)(this.pythonPath, ['-m', 'qvac_audiogen_diffusers'], {
            stdio: ['overlapped', 'overlapped', 'overlapped']
        });
        if (child.stdin === null || child.stdout === null) {
            child.kill();
            throw new Error('failed to create Python worker pipes');
        }
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.consume(String(chunk)));
        child.on('exit', () => {
            this.child = null;
        });
        this.child = child;
    }
    load(config) {
        this.send({ version: 1, op: 'load', config });
    }
    generate(request) {
        this.send({ version: 1, op: 'generate', ...request });
    }
    cancel(requestId) {
        this.send({ version: 1, op: 'cancel', requestId });
    }
    unload() {
        this.send({ version: 1, op: 'unload' });
    }
    destroy() {
        if (this.child === null)
            return;
        this.child.kill();
        this.child = null;
    }
    send(request) {
        if (this.child?.stdin === null || this.child === null) {
            throw new Error('Python worker is not running');
        }
        this.child.stdin.write((0, protocol_1.encodeWorkerRequest)(request));
    }
    consume(chunk) {
        this.pending += chunk;
        for (;;) {
            const newline = this.pending.indexOf('\n');
            if (newline < 0)
                return;
            const line = this.pending.slice(0, newline);
            this.pending = this.pending.slice(newline + 1);
            if (line.length === 0)
                continue;
            this.onEvent((0, protocol_1.parseWorkerEvent)(JSON.parse(line)));
        }
    }
}
exports.MiniMaxDiffusersWorker = MiniMaxDiffusersWorker;
