"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareVideoInput = prepareVideoInput;
exports.openVideoFormat = openVideoFormat;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare dependencies are CommonJS. */
const fs = require("bare-fs");
const path = require("bare-path");
const os = require("bare-os");
const ffmpeg = require("bare-ffmpeg");
/* eslint-enable @typescript-eslint/no-require-imports */
const error_1 = require("../utils/error");
const config_1 = require("./config");
async function nextChunk(iterator, signal) {
    (0, config_1.checkCancelled)(signal);
    if (!signal)
        return iterator.next();
    let onAbort;
    try {
        return await Promise.race([
            iterator.next(),
            new Promise((_resolve, reject) => {
                onAbort = () => reject((0, config_1.videoError)(error_1.ERR_CODES.JOB_CANCELLED, "Video input cancelled"));
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted)
                    onAbort();
            }),
        ]);
    }
    finally {
        if (onAbort)
            signal.removeEventListener("abort", onAbort);
    }
}
function validateSize(size, maxBytes) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
        throw (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_LIMIT_EXCEEDED, `Input must contain 1..${maxBytes} bytes`);
    }
}
function fileReader(filePath, maxBytes) {
    const fd = fs.openSync(filePath, "r");
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
            throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Input must be a regular file");
        validateSize(stat.size, maxBytes);
        return {
            size: stat.size,
            read(offset, length) {
                const buffer = Buffer.allocUnsafe(length);
                const count = fs.readSync(fd, buffer, 0, length, offset);
                return buffer.subarray(0, count);
            },
            close() { fs.closeSync(fd); },
        };
    }
    catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}
/** Chunk streams are finite files, not live sessions. Temp paths never escape this owner. */
async function prepareVideoInput(input, maxBytes, tempDirectory, signal) {
    (0, config_1.checkCancelled)(signal);
    if (typeof input === "string")
        return fileReader(input, maxBytes);
    if (input instanceof Uint8Array) {
        validateSize(input.byteLength, maxBytes);
        return {
            size: input.byteLength,
            read(offset, length) { return input.subarray(offset, offset + length); },
            close() { },
        };
    }
    if (!input || typeof input !== "object")
        throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Unsupported video input");
    if ("size" in input && "read" in input && typeof input.read === "function") {
        validateSize(input.size, maxBytes);
        return { size: input.size, read: input.read.bind(input), close() { } };
    }
    if (!(Symbol.asyncIterator in input))
        throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Input must be seekable or an async byte iterable");
    const directory = fs.mkdtempSync(path.join(tempDirectory ?? os.tmpdir(), "qvac-video-"));
    const filename = path.join(directory, "input.bin");
    let fd;
    const iterator = input[Symbol.asyncIterator]();
    let inputComplete = false;
    try {
        fd = fs.openSync(filename, "wx", 0o600);
        let size = 0;
        while (true) {
            const next = await nextChunk(iterator, signal);
            if (next.done) {
                inputComplete = true;
                break;
            }
            const chunk = next.value;
            (0, config_1.checkCancelled)(signal);
            if (!(chunk instanceof Uint8Array))
                throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Every input chunk must be bytes");
            if (chunk.byteLength > maxBytes - size)
                throw (0, config_1.videoError)(error_1.ERR_CODES.VIDEO_LIMIT_EXCEEDED, "Chunked input exceeds byte limit");
            const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            let offset = 0;
            while (offset < buffer.byteLength) {
                const count = fs.writeSync(fd, buffer, offset, buffer.byteLength - offset);
                if (count <= 0)
                    throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Unable to stage input");
                offset += count;
            }
            size += chunk.byteLength;
        }
        fs.closeSync(fd);
        fd = undefined;
        (0, config_1.checkCancelled)(signal);
        const reader = fileReader(filename, maxBytes);
        return {
            size: reader.size,
            read: reader.read.bind(reader),
            close() {
                try {
                    reader.close();
                }
                finally {
                    fs.unlinkSync(filename);
                    fs.rmdirSync(directory);
                }
            },
        };
    }
    catch (error) {
        if (fd !== undefined)
            fs.closeSync(fd);
        if (fs.existsSync(filename))
            fs.unlinkSync(filename);
        fs.rmdirSync(directory);
        throw error;
    }
    finally {
        // A producer may be blocked waiting for more bytes. Do not delay privacy cleanup
        // waiting for its return(); cancellation of the producer itself remains cooperative.
        if (!inputComplete && iterator.return)
            void Promise.resolve(iterator.return()).catch(() => { });
    }
}
/** Reopen the demuxer on the same reader after the cheap key-frame packet scan. */
function openVideoFormat(reader, signal) {
    let offset = 0;
    const io = new ffmpeg.IOContext(config_1.VIDEO_LIMITS.ioBufferBytes, {
        onread(buffer, requested) {
            (0, config_1.checkCancelled)(signal);
            const length = Math.min(requested, buffer.byteLength, reader.size - offset);
            if (length <= 0)
                return 0;
            const bytes = reader.read(offset, length);
            if (!(bytes instanceof Uint8Array) || bytes.byteLength > length || bytes.byteLength === 0) {
                throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Invalid or prematurely exhausted seekable reader");
            }
            buffer.set(bytes);
            offset += bytes.byteLength;
            return bytes.byteLength;
        },
        onseek(delta, whence) {
            if (whence & 0x10000)
                return reader.size; // AVSEEK_SIZE
            const base = whence & ~0x20000; // AVSEEK_FORCE
            const next = base === 0 ? delta : base === 1 ? offset + delta : base === 2 ? reader.size + delta : -1;
            if (!Number.isSafeInteger(next) || next < 0 || next > reader.size)
                return -1;
            offset = next;
            return offset;
        },
    });
    try {
        return new ffmpeg.InputFormatContext(io);
    }
    finally {
        io.destroy();
    }
}
