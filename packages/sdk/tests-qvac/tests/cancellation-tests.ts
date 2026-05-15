// Cancellation-path e2e tests.
//
// Covers the three observable contracts that typed cancel outcomes +
// KvCacheSession introduce:
//
//  1. `cancel-mid-stream-completion` — mid-stream cancel:
//     - `events` stream ends with `stopReason: "cancelled"`
//     - `run.final` rejects with `InferenceCancelledError`
//     - `error.partial.text` equals the concatenated `contentDelta`
//       content that arrived before the cancel landed.
//
//  2. `cancel-before-begin-completion` — synthetic same-tick race:
//     fire `cancel({ requestId })` immediately after `completion(...)`
//     returns, before the worker has had a chance to call
//     `registry.begin(...)`. Asserts that the cancelled-before-begin
//     map applies the cancel retroactively (events end with
//     `stopReason: "cancelled"`, `final` rejects with
//     `InferenceCancelledError`).
//
//  3. `cancel-then-resume-kv-cache` — mid-stream cancel on a `kvCache:
//     "session-..."` turn followed by a fresh turn on the same key:
//     asserts that `KvCacheSession.rollback(...)` wiped the three KV
//     layers atomically and the next turn re-primes cleanly. Distinct
//     from `kv-cache-cancel-then-new-prompt` because this one asserts
//     the typed cancel outcome on the first run *and* the clean reprime
//     on the second run together.
import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const cancelMidStreamCompletion: TestDefinition = {
  testId: "cancel-mid-stream-completion",
  params: {
    prompt: "Tell me a long story about dragons, in many sentences.",
    cancelAfterTokens: 3,
  },
  expectation: { validation: "function", fn: () => true },
  suites: ["verify"],
  metadata: {
    category: "completion",
    dependency: "llm",
    estimatedDurationMs: 20000,
  },
};

export const cancelBeforeBeginCompletion: TestDefinition = {
  testId: "cancel-before-begin-completion",
  params: {
    prompt: "Write a paragraph about the history of cryptography.",
  },
  expectation: { validation: "function", fn: () => true },
  suites: ["verify"],
  metadata: {
    category: "completion",
    dependency: "llm",
    estimatedDurationMs: 20000,
  },
};

export const cancelThenResumeKvCache: TestDefinition = {
  testId: "cancel-then-resume-kv-cache",
  params: {
    cacheKey: "cancel-then-resume-kvcache",
    firstUserMessage: "Tell me a long story about wizards.",
    // Repeat-word is the safest deterministic assertion: small chat models follow it
    // reliably, and `banana` is rare enough in filler text to avoid comparator false positives.
    secondUserMessage: "Repeat this word: banana",
    expectedAnswerContains: "banana",
    cancelAfterTokens: 3,
  },
  expectation: { validation: "function", fn: () => true },
  suites: ["verify"],
  metadata: {
    category: "completion",
    dependency: "llm",
    estimatedDurationMs: 30000,
  },
};

export const cancellationTests = [
  cancelMidStreamCompletion,
  cancelBeforeBeginCompletion,
  cancelThenResumeKvCache,
];
