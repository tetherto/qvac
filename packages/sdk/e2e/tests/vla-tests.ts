import type { TestDefinition } from "@tetherto/qvac-test-suite";

// SmolVLA-LIBERO inference always returns a chunkSize × actionDim Float32Array
// of robot actions plus per-stage timings. These tests exercise the SDK's
// `vla()` / `vlaHparams()` client functions end-to-end against a registry-
// loaded model — the real LIBERO numerical correctness check lives in the
// addon's own integration suite (which has access to the PyTorch reference
// fixtures); here we focus on the SDK shape contract.

const createVlaTest = (
  testId: string,
  params: Record<string, unknown>,
  expectation:
    | { validation: "type"; expectedType: "string" | "number" | "array" }
    | { validation: "function"; fn: (result: unknown) => { passed: boolean; output?: string } },
  estimatedDurationMs: number = 300000,
  suites?: string[],
  dependency: string = "vla",
): TestDefinition => ({
  testId,
  params,
  expectation,
  ...(suites && { suites }),
  metadata: { category: "vla", dependency, estimatedDurationMs },
});

// hparams shape: chunkSize, actionDim, maxStateDim, etc. must all be
// positive integers and backendName must be one of the addon's accepted
// backend strings (CPU when we load with `{ backend: "cpu" }`).
export const vlaHparamsShape = createVlaTest(
  "vla-hparams-shape",
  {},
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as { hparams?: Record<string, number>; backendName?: string | null };
      if (!r.hparams) return { passed: false, output: "missing hparams" };
      const required = [
        "chunkSize",
        "actionDim",
        "maxActionDim",
        "maxStateDim",
        "tokenizerMaxLength",
        "visionImageSize",
      ];
      for (const k of required) {
        const v = r.hparams[k];
        if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
          return { passed: false, output: `hparams.${k} not a positive integer (got ${v})` };
        }
      }
      const knownBackends = new Set(["CPU", "Metal", "Vulkan", "OpenCL"]);
      if (r.backendName !== null && !knownBackends.has(r.backendName ?? "")) {
        return { passed: false, output: `unknown backendName: ${r.backendName}` };
      }
      return { passed: true };
    },
  },
  60000,
  ["smoke"],
);

// Synthetic inputs: zero-filled gray images + BOS-only tokens + zero state
// + zero noise. The model still runs the full pipeline (vision encoder +
// SmolLM2 prefill + flow-matching ODE) and produces a syntactically valid
// action chunk; we don't assert on the action values because they're
// undefined-behaviour-ish on degenerate inputs.
export const vlaRunSyntheticShape = createVlaTest(
  "vla-run-synthetic-shape",
  { inputs: "synthetic" },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as {
        actionsLength?: number;
        expectedLength?: number;
        actionDim?: number;
        chunkSize?: number;
      };
      if (r.actionsLength !== r.expectedLength) {
        return {
          passed: false,
          output: `actions.length=${r.actionsLength} != chunkSize*actionDim=${r.expectedLength}`,
        };
      }
      if (!r.actionDim || !r.chunkSize) {
        return { passed: false, output: "actionDim/chunkSize missing on result" };
      }
      return { passed: true };
    },
  },
  300000,
  ["smoke"],
);

// Per-stage timings should all be non-negative numbers and the total wall
// time should be >0 on real inference.
export const vlaRunStats = createVlaTest(
  "vla-run-stats",
  { inputs: "synthetic" },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as { stats?: Record<string, number> };
      if (!r.stats) return { passed: false, output: "stats missing" };
      const keys = ["vision_ms", "smollm2_compute_ms", "smollm2_total_ms", "ode_ms", "total_ms"];
      for (const k of keys) {
        const v = r.stats[k];
        if (typeof v !== "number" || v < 0) {
          return { passed: false, output: `stats.${k} not a non-negative number (got ${v})` };
        }
      }
      if (!(r.stats["total_ms"]! > 0)) {
        return { passed: false, output: `stats.total_ms must be > 0 (got ${r.stats["total_ms"]})` };
      }
      return { passed: true };
    },
  },
);

// `imgWidth ≠ hparams.visionImageSize` must reject cleanly with a
// QvacError mentioning the mismatch, and the model must remain usable
// for a follow-up canonical-shape run() — the JS-side validator clears
// `_hasActiveResponse` on the rejection path.
export const vlaInvalidImgSize = createVlaTest(
  "vla-invalid-img-size",
  { inputs: "synthetic-wrong-img-size" },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as { rejected?: boolean; recoveryRan?: boolean; errorMsg?: string };
      if (!r.rejected) return { passed: false, output: "expected run() to reject on img-size mismatch" };
      if (!/imgWidth|imgHeight|visionImageSize/i.test(r.errorMsg ?? "")) {
        return { passed: false, output: `error message did not mention img dims (got: ${r.errorMsg})` };
      }
      if (!r.recoveryRan) {
        return { passed: false, output: "follow-up canonical run() did not succeed after rejection" };
      }
      return { passed: true };
    },
  },
);

// ── π₀.₅ (pi05) ──────────────────────────────────────────────────────────
// Same SDK shape contract as SmolVLA, against the `vla-pi05` resource
// (3 cameras, discrete state). The shared, hparams-driven executor reads
// `hparams.numCameras` / `hparams.stateInputMode` to shape inputs, so the
// only per-arch differences are the model and a couple of extra assertions:
// the hparams test checks numCameras === 3 / stateInputMode === "discrete",
// and the stats test checks the architecture-neutral prefill_* timing keys.

export const vlaPi05HparamsShape = createVlaTest(
  "vla-pi05-hparams-shape",
  {},
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as { hparams?: Record<string, number | string>; backendName?: string | null };
      if (!r.hparams) return { passed: false, output: "missing hparams" };
      const required = [
        "chunkSize",
        "actionDim",
        "maxActionDim",
        "maxStateDim",
        "tokenizerMaxLength",
        "visionImageSize",
      ];
      for (const k of required) {
        const v = r.hparams[k];
        if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
          return { passed: false, output: `hparams.${k} not a positive integer (got ${v})` };
        }
      }
      if (r.hparams["numCameras"] !== 3) {
        return { passed: false, output: `hparams.numCameras expected 3 (got ${r.hparams["numCameras"]})` };
      }
      if (r.hparams["stateInputMode"] !== "discrete") {
        return { passed: false, output: `hparams.stateInputMode expected "discrete" (got ${r.hparams["stateInputMode"]})` };
      }
      const knownBackends = new Set(["CPU", "Metal", "Vulkan", "OpenCL"]);
      if (r.backendName !== null && !knownBackends.has(r.backendName ?? "")) {
        return { passed: false, output: `unknown backendName: ${r.backendName}` };
      }
      return { passed: true };
    },
  },
  60000,
  ["smoke"],
  "vla-pi05",
);

// Exercises the 3-camera + discrete-state path: the executor feeds three
// camera frames, an empty state buffer, and a noise prior (required by pi05).
export const vlaPi05RunSyntheticShape = createVlaTest(
  "vla-pi05-run-synthetic-shape",
  { inputs: "synthetic" },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as {
        actionsLength?: number;
        expectedLength?: number;
        actionDim?: number;
        chunkSize?: number;
        numImages?: number;
        stateLength?: number;
      };
      if (r.actionsLength !== r.expectedLength) {
        return { passed: false, output: `actions.length=${r.actionsLength} != chunkSize*actionDim=${r.expectedLength}` };
      }
      if (!r.actionDim || !r.chunkSize) {
        return { passed: false, output: "actionDim/chunkSize missing on result" };
      }
      if (r.numImages !== 3) {
        return { passed: false, output: `expected 3 camera images for pi05 (got ${r.numImages})` };
      }
      if (r.stateLength !== 0) {
        return { passed: false, output: `discrete-state pi05 should run with an empty state (got length ${r.stateLength})` };
      }
      return { passed: true };
    },
  },
  300000,
  ["smoke"],
  "vla-pi05",
);

export const vlaPi05RunStats = createVlaTest(
  "vla-pi05-run-stats",
  { inputs: "synthetic" },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as { stats?: Record<string, number> };
      if (!r.stats) return { passed: false, output: "stats missing" };
      const keys = ["vision_ms", "prefill_compute_ms", "prefill_total_ms", "ode_ms", "total_ms"];
      for (const k of keys) {
        const v = r.stats[k];
        if (typeof v !== "number" || v < 0) {
          return { passed: false, output: `stats.${k} not a non-negative number (got ${v})` };
        }
      }
      if (!(r.stats["total_ms"]! > 0)) {
        return { passed: false, output: `stats.total_ms must be > 0 (got ${r.stats["total_ms"]})` };
      }
      return { passed: true };
    },
  },
  300000,
  undefined,
  "vla-pi05",
);

export const vlaPi05InvalidImgSize = createVlaTest(
  "vla-pi05-invalid-img-size",
  { inputs: "synthetic-wrong-img-size" },
  {
    validation: "function",
    fn: (result: unknown) => {
      const r = result as { rejected?: boolean; recoveryRan?: boolean; errorMsg?: string };
      if (!r.rejected) return { passed: false, output: "expected run() to reject on img-size mismatch" };
      if (!/imgWidth|imgHeight|visionImageSize/i.test(r.errorMsg ?? "")) {
        return { passed: false, output: `error message did not mention img dims (got: ${r.errorMsg})` };
      }
      if (!r.recoveryRan) {
        return { passed: false, output: "follow-up canonical run() did not succeed after rejection" };
      }
      return { passed: true };
    },
  },
  300000,
  undefined,
  "vla-pi05",
);

export const vlaTests: TestDefinition[] = [
  vlaHparamsShape,
  vlaRunSyntheticShape,
  vlaRunStats,
  vlaInvalidImgSize,
  vlaPi05HparamsShape,
  vlaPi05RunSyntheticShape,
  vlaPi05RunStats,
  vlaPi05InvalidImgSize,
];
