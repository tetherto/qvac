"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_FLUSH_AFTER_MS = void 0;
exports.splitGraphemeHead = splitGraphemeHead;
exports.buildSentenceEndTester = buildSentenceEndTester;
exports.defaultMaxBufferScalars = defaultMaxBufferScalars;
exports.accumulateTextStream = accumulateTextStream;
const textChunker_1 = require("./textChunker");
exports.DEFAULT_FLUSH_AFTER_MS = 500;
function splitGraphemeHead(value, count) {
    const graphemes = [...value];
    if (graphemes.length <= count)
        return { head: value, rest: "" };
    return {
        head: graphemes.slice(0, count).join(""),
        rest: graphemes.slice(count).join(""),
    };
}
function buildSentenceEndTester(options) {
    if (options.sentenceDelimiter instanceof RegExp) {
        const expression = options.sentenceDelimiter;
        return function testCustom(buffer) {
            expression.lastIndex = 0;
            return expression.test(buffer);
        };
    }
    const patterns = {
        latin: /[.!?…]\s*$/u,
        cjk: /[。！？…]\s*$/u,
        multilingual: /(?:[.!?…؟]|[。！？…])\s*$/u,
    };
    const preset = options.sentenceDelimiterPreset || "multilingual";
    const expression = patterns[preset] || patterns.multilingual;
    return function testPreset(buffer) {
        return expression.test(buffer);
    };
}
function defaultMaxBufferScalars(language) {
    return (0, textChunker_1.defaultMaxChunkScalars)(language);
}
async function* accumulateTextStream(source, options = {}) {
    const flushAfterMs = options.flushAfterMs ?? exports.DEFAULT_FLUSH_AFTER_MS;
    const defaultMaximum = defaultMaxBufferScalars(options.language);
    const configuredMaximum = Number(options.maxBufferScalars);
    const maxScalars = options.maxBufferScalars == null ||
        !Number.isFinite(configuredMaximum) ||
        configuredMaximum <= 0
        ? defaultMaximum
        : configuredMaximum;
    const testEnd = buildSentenceEndTester(options);
    const queue = [];
    let notify = null;
    function push(item) {
        queue.push(item);
        if (notify) {
            const resolve = notify;
            notify = null;
            resolve();
        }
    }
    void (async function pump() {
        let buffer = "";
        let idleTimer = null;
        function clearIdle() {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        }
        function armIdle() {
            clearIdle();
            idleTimer = setTimeout(() => {
                idleTimer = null;
                const text = buffer.trim();
                if (text) {
                    buffer = "";
                    push({ kind: "chunk", text });
                }
            }, flushAfterMs);
        }
        try {
            for await (const fragment of source) {
                clearIdle();
                buffer += String(fragment);
                while ((0, textChunker_1.countScalars)(buffer) >= maxScalars) {
                    const { head, rest } = splitGraphemeHead(buffer, maxScalars);
                    buffer = rest;
                    if (head.length > 0)
                        push({ kind: "chunk", text: head });
                }
                if (testEnd(buffer)) {
                    const text = buffer.trim();
                    buffer = "";
                    if (text)
                        push({ kind: "chunk", text });
                }
                armIdle();
            }
            clearIdle();
            const tail = buffer.trim();
            if (tail)
                push({ kind: "chunk", text: tail });
            push({ kind: "done" });
        }
        catch (error) {
            clearIdle();
            push({ kind: "err", error });
        }
    })();
    while (true) {
        while (queue.length === 0) {
            await new Promise((resolve) => {
                notify = resolve;
            });
        }
        const item = queue.shift();
        if (!item || item.kind === "done")
            return;
        if (item.kind === "err")
            throw item.error;
        yield item.text;
    }
}
