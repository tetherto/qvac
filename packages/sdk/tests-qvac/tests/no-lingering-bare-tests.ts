import type { TestDefinition } from "@tetherto/qvac-test-suite";

const SKIP_MOBILE = {
  reason: "Bare worker process lifecycle is desktop-only (mobile uses in-process Worklet)",
  platforms: ["mobile-ios", "mobile-android"],
};

const createNoLingeringBareTest = (
  testId: string,
  estimatedDurationMs: number = 90000,
): TestDefinition => ({
  testId,
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "lifecycle",
    dependency: "none",
    estimatedDurationMs,
  },
  skip: SKIP_MOBILE,
});

export const noLingeringBareSigterm = createNoLingeringBareTest(
  "no-lingering-bare-sigterm",
);

export const noLingeringBareClose = createNoLingeringBareTest(
  "no-lingering-bare-close",
);

export const noLingeringBareIpcDisconnect = createNoLingeringBareTest(
  "no-lingering-bare-ipc-disconnect",
);

export const noLingeringBareTests = [
  noLingeringBareSigterm,
  noLingeringBareClose,
  noLingeringBareIpcDisconnect,
] as const;
