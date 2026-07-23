"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flattenSegments = flattenSegments;
function isSegment(x) {
    return (typeof x === "object" &&
        x !== null &&
        typeof x.text === "string");
}
function flattenSegments(output) {
    const segments = [];
    for (const entry of output) {
        if (Array.isArray(entry)) {
            segments.push(...entry);
        }
        else if (isSegment(entry)) {
            segments.push(entry);
        }
    }
    return segments;
}
