import { type TranscriptSegment } from "./stream";

function isSegment(x: unknown): x is TranscriptSegment {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { text?: unknown }).text === "string"
  );
}

export function flattenSegments(output: Iterable<unknown>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const entry of output) {
    if (Array.isArray(entry)) {
      segments.push(...(entry as TranscriptSegment[]));
    } else if (isSegment(entry)) {
      segments.push(entry);
    }
  }
  return segments;
}
