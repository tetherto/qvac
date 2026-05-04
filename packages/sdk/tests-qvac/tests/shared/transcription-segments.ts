import type { TranscribeSegment } from "@qvac/sdk";
import type { TestResult } from "@tetherto/qvac-test-suite";

export function validateSegments(segments: unknown): TestResult {
  if (!Array.isArray(segments)) {
    return { passed: false, output: `Expected array, got ${typeof segments}` };
  }
  if (segments.length === 0) {
    return { passed: false, output: "Expected at least one segment" };
  }

  let prevStartMs = -Infinity;
  let prevId = -Infinity;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Partial<TranscribeSegment>;
    if (typeof seg !== "object" || seg === null) {
      return { passed: false, output: `Segment ${i}: not an object` };
    }
    if (typeof seg.text !== "string") {
      return { passed: false, output: `Segment ${i}: missing/invalid text` };
    }
    if (typeof seg.startMs !== "number" || !Number.isFinite(seg.startMs)) {
      return { passed: false, output: `Segment ${i}: missing/invalid startMs` };
    }
    if (typeof seg.endMs !== "number" || !Number.isFinite(seg.endMs)) {
      return { passed: false, output: `Segment ${i}: missing/invalid endMs` };
    }
    if (seg.endMs < seg.startMs) {
      return {
        passed: false,
        output: `Segment ${i}: endMs (${seg.endMs}) < startMs (${seg.startMs})`,
      };
    }
    if (typeof seg.append !== "boolean") {
      return { passed: false, output: `Segment ${i}: missing/invalid append` };
    }
    if (typeof seg.id !== "number" || !Number.isInteger(seg.id)) {
      return { passed: false, output: `Segment ${i}: missing/invalid id` };
    }
    if (seg.startMs < prevStartMs) {
      return {
        passed: false,
        output:
          `Segment ${i}: out-of-order startMs (${seg.startMs}) < ` +
          `previous startMs (${prevStartMs}). Segments must be emitted ` +
          `in audio-time order.`,
      };
    }
    if (seg.id < prevId) {
      return {
        passed: false,
        output:
          `Segment ${i}: out-of-order id (${seg.id}) < previous id ` +
          `(${prevId}). Whisper segment ids must be non-decreasing.`,
      };
    }
    prevStartMs = seg.startMs;
    prevId = seg.id;
  }

  return {
    passed: true,
    output:
      `Validated ${segments.length} segment(s): shape OK and emitted in ` +
      `non-decreasing audio-time order.`,
  };
}
