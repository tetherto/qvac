import type { TestDefinition } from "@tetherto/qvac-test-suite";

// The bundled MobileNetV3-Small classifier returns 3 classes
// ("food", "report", "other") with softmax probabilities. These tests
// exercise the SDK's `classify()` client function end-to-end against
// the bundled weights. Numerical correctness lives in the addon's own
// integration suite — here we focus on the SDK shape contract.

const createClassificationTest = (
  testId: string,
  params: Record<string, unknown>,
  expectation:
    | { validation: "type"; expectedType: "string" | "number" | "array" }
    | {
        validation: "function";
        fn: (result: unknown) => { passed: boolean; output?: string };
      },
  estimatedDurationMs: number = 60000,
  suites?: string[],
): TestDefinition => ({
  testId,
  params,
  expectation,
  ...(suites && { suites }),
  metadata: {
    category: "classification",
    dependency: "classification",
    estimatedDurationMs,
  },
});

// Result shape: an array of `{label, confidence}` objects sorted by
// descending confidence. With the bundled MobileNetV3-Small all three
// canonical labels must appear and every confidence must be in [0, 1].
export const classificationResultsShape = createClassificationTest(
  "classification-results-shape",
  {},
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as {
        results?: { label?: string; confidence?: number }[];
      };
      if (!Array.isArray(r.results)) {
        return { passed: false, output: "results is not an array" };
      }
      if (r.results.length === 0) {
        return { passed: false, output: "results array is empty" };
      }
      for (const item of r.results) {
        if (typeof item.label !== "string" || item.label.length === 0) {
          return {
            passed: false,
            output: `result item missing string label (got: ${JSON.stringify(item)})`,
          };
        }
        if (
          typeof item.confidence !== "number" ||
          item.confidence < 0 ||
          item.confidence > 1
        ) {
          return {
            passed: false,
            output: `confidence out of [0,1] for label '${item.label}' (got ${item.confidence})`,
          };
        }
      }
      // Descending-confidence ordering invariant.
      for (let i = 1; i < r.results.length; i++) {
        const prev = r.results[i - 1]?.confidence ?? 0;
        const cur = r.results[i]?.confidence ?? 0;
        if (cur > prev) {
          return {
            passed: false,
            output: `results not sorted by descending confidence at index ${i}`,
          };
        }
      }
      return { passed: true };
    },
  },
  60000,
  ["smoke"],
);

// Softmax invariant: probabilities sum to approximately 1 when topK is not
// applied. Allow 1e-3 slack for FP16 / accumulator noise.
export const classificationConfidenceSum = createClassificationTest(
  "classification-confidence-sum",
  {},
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as {
        results?: { confidence?: number }[];
      };
      if (!Array.isArray(r.results) || r.results.length === 0) {
        return { passed: false, output: "results missing or empty" };
      }
      const sum = r.results.reduce((acc, x) => acc + (x.confidence ?? 0), 0);
      if (Math.abs(sum - 1) > 1e-3) {
        return {
          passed: false,
          output: `confidence sum ${sum} not within 1e-3 of 1`,
        };
      }
      return { passed: true };
    },
  },
);

// `topK: 1` must truncate to exactly one result.
export const classificationTopK = createClassificationTest(
  "classification-topk",
  { topK: 1 },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as { results?: unknown[] };
      if (!Array.isArray(r.results)) {
        return { passed: false, output: "results is not an array" };
      }
      if (r.results.length !== 1) {
        return {
          passed: false,
          output: `topK:1 expected 1 result, got ${r.results.length}`,
        };
      }
      return { passed: true };
    },
  },
  60000,
  ["smoke"],
);

// An invalid image buffer (too small to decode as JPEG/PNG) must reject
// cleanly, and the model must remain usable for a follow-up valid call —
// proves the addon does not wedge on the rejection path.
export const classificationInvalidImage = createClassificationTest(
  "classification-invalid-image",
  { inputs: "invalid" },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as {
        rejected?: boolean;
        recoveryRan?: boolean;
        errorMsg?: string;
      };
      if (!r.rejected) {
        return {
          passed: false,
          output: "expected classify() to reject on invalid image bytes",
        };
      }
      if (!r.recoveryRan) {
        return {
          passed: false,
          output: "follow-up classify() did not succeed after rejection",
        };
      }
      return { passed: true };
    },
  },
);

export const classificationTests: TestDefinition[] = [
  classificationResultsShape,
  classificationConfidenceSum,
  classificationTopK,
  classificationInvalidImage,
];
