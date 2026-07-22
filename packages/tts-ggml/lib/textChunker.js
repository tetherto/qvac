"use strict";
/**
 * Text chunking for sentence-stream TTS. Intl.Segmenter is used when present;
 * Bare runtimes without it fall back to punctuation and max-length splitting.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_CHUNK_SCALARS = exports.KOREAN_MAX_CHUNK_SCALARS = void 0;
exports.intlSentenceSegmentationAvailable = intlSentenceSegmentationAvailable;
exports.splitByIntlSentences = splitByIntlSentences;
exports.splitByAsciiAndCjkPunctuation = splitByAsciiAndCjkPunctuation;
exports.countScalars = countScalars;
exports.defaultMaxChunkScalars = defaultMaxChunkScalars;
exports.splitTtsText = splitTtsText;
function intlSentenceSegmentationAvailable() {
    return (typeof Intl !== "undefined" &&
        "Segmenter" in Intl &&
        typeof Intl.Segmenter === "function");
}
function splitByIntlSentences(text, locale) {
    if (!intlSentenceSegmentationAvailable())
        return null;
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    try {
        const segmenter = new Intl.Segmenter(locale || "en", {
            granularity: "sentence",
        });
        const output = [];
        for (const segment of segmenter.segment(trimmed)) {
            const part = segment.segment.trim();
            if (part.length > 0)
                output.push(part);
        }
        return output.length === 0 ? null : output;
    }
    catch {
        return null;
    }
}
const SENTENCE_TERMINATORS = /([.!?。！？؟])(\s*)/gu;
function splitByAsciiAndCjkPunctuation(text) {
    const parts = [];
    let lastIndex = 0;
    let match;
    while ((match = SENTENCE_TERMINATORS.exec(text)) !== null) {
        const end = match.index + match[1].length;
        const slice = text.slice(lastIndex, end).trim();
        if (slice.length > 0)
            parts.push(slice);
        lastIndex = match.index + match[0].length;
    }
    const tail = text.slice(lastIndex).trim();
    if (tail.length > 0)
        parts.push(tail);
    return parts;
}
function splitByParagraphs(text) {
    return text
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0);
}
const MIN_CHUNK_GRAPHEMES = 10;
function mergeShortChunks(chunks) {
    const merged = [];
    let buffer = "";
    for (const chunk of chunks) {
        if (buffer.length === 0) {
            buffer = chunk;
            continue;
        }
        if ([...buffer].length < MIN_CHUNK_GRAPHEMES) {
            buffer = buffer + " " + chunk;
        }
        else {
            merged.push(buffer);
            buffer = chunk;
        }
    }
    if (buffer.length > 0)
        merged.push(buffer);
    return merged;
}
function countScalars(value) {
    return [...value].length;
}
const MIN_HARD_SPLIT_SCALARS = 10;
function hardSplitByMaxScalars(text, maxScalars) {
    const maximum = Math.max(maxScalars, MIN_HARD_SPLIT_SCALARS);
    const graphemes = [...text];
    if (graphemes.length <= maximum)
        return [text];
    const output = [];
    for (let index = 0; index < graphemes.length; index += maximum) {
        output.push(graphemes.slice(index, index + maximum).join(""));
    }
    return output;
}
function mergeUpToMaxScalars(pieces, maxScalars) {
    const output = [];
    let current = "";
    for (const rawPiece of pieces) {
        const piece = rawPiece.trim();
        if (!piece)
            continue;
        const trial = current.length ? `${current} ${piece}` : piece;
        if (countScalars(trial) <= maxScalars) {
            current = trial;
        }
        else {
            if (current.length > 0) {
                output.push(...hardSplitByMaxScalars(current, maxScalars));
            }
            current = piece;
        }
    }
    if (current.length > 0) {
        output.push(...hardSplitByMaxScalars(current, maxScalars));
    }
    return output.filter((value) => value.trim().length > 0);
}
exports.KOREAN_MAX_CHUNK_SCALARS = 120;
exports.DEFAULT_MAX_CHUNK_SCALARS = 300;
function defaultMaxChunkScalars(language) {
    return (language || "en").toLowerCase() === "ko"
        ? exports.KOREAN_MAX_CHUNK_SCALARS
        : exports.DEFAULT_MAX_CHUNK_SCALARS;
}
function splitTtsText(text, options = {}) {
    const mergeToMaxScalars = options.mergeToMaxScalars !== false;
    const language = (options.language || "en").toLowerCase();
    const maxScalars = options.maxScalars ?? defaultMaxChunkScalars(language);
    const raw = text.trim();
    if (!raw)
        return [];
    let sentences = splitByIntlSentences(raw, options.locale || language);
    if (!sentences || sentences.length === 0) {
        const paragraphs = splitByParagraphs(raw);
        const blocks = paragraphs.length > 0 ? paragraphs : [raw];
        sentences = [];
        for (const paragraph of blocks) {
            const split = splitByAsciiAndCjkPunctuation(paragraph);
            const merged = mergeShortChunks(split.length > 0 ? split : [paragraph]);
            for (const chunk of merged) {
                if (chunk.trim())
                    sentences.push(chunk.trim());
            }
        }
    }
    if (sentences.length === 0) {
        return mergeToMaxScalars
            ? mergeUpToMaxScalars([raw], maxScalars)
            : [raw];
    }
    return mergeToMaxScalars
        ? mergeUpToMaxScalars(sentences, maxScalars)
        : sentences;
}
