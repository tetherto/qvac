import test from "brittle";
import {
  batchCompletionClientParamsSchema,
  batchCompletionStreamRequestSchema,
  batchCompletionStreamResponseSchema,
} from "@/schemas/batch-completion-stream";
import { requestSchema, responseSchema } from "@/schemas/common";

const prompt = {
  id: "first",
  history: [{ role: "user", content: "Reply with APPLE only." }],
  generationParams: { temp: 0, seed: 42 },
  responseFormat: { type: "text" as const },
};

test("batchCompletionClientParamsSchema: accepts batch prompts", (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: "llama",
    prompts: [prompt],
    stream: true,
    captureThinking: true,
  });
  t.is(result.success, true);
});

test("batchCompletionClientParamsSchema: requires at least one prompt", (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: "llama",
    prompts: [],
  });
  t.is(result.success, false);
});

test("batchCompletionClientParamsSchema: rejects duplicate prompt ids", (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: "llama",
    prompts: [
      { id: "dup", history: [{ role: "user", content: "a" }] },
      { id: "dup", history: [{ role: "user", content: "b" }] },
    ],
  });
  t.is(result.success, false);
});

test("batchCompletionClientParamsSchema: allows multiple prompts without ids", (t) => {
  const result = batchCompletionClientParamsSchema.safeParse({
    modelId: "llama",
    prompts: [
      { history: [{ role: "user", content: "a" }] },
      { history: [{ role: "user", content: "b" }] },
    ],
  });
  t.is(result.success, true);
});

test("batchCompletionStreamRequestSchema: validates wire request", (t) => {
  const request = {
    type: "batchCompletionStream",
    modelId: "llama",
    prompts: [prompt],
    requestId: "req-1",
  };
  t.is(batchCompletionStreamRequestSchema.safeParse(request).success, true);
  t.is(requestSchema.safeParse(request).success, true);
});

test("batchCompletionStreamResponseSchema: validates id-tagged events with batch-level stats", (t) => {
  // Stats are batch-level: they ride the top-level `stats` field on the
  // done frame, NOT a per-id completionStats event.
  const response = {
    type: "batchCompletionStream",
    ids: ["first"],
    done: true,
    events: [
      {
        id: "first",
        event: { type: "contentDelta", seq: 0, text: "APPLE" },
      },
      {
        id: "first",
        event: { type: "completionDone", seq: 1 },
      },
    ],
    stats: { avgConcurrentSeq: 1, generatedTokens: 1 },
  };
  t.is(batchCompletionStreamResponseSchema.safeParse(response).success, true);
  t.is(responseSchema.safeParse(response).success, true);
});

test("batchCompletionStreamResponseSchema: stats is optional", (t) => {
  const response = {
    type: "batchCompletionStream",
    ids: ["first"],
    done: true,
    events: [{ id: "first", event: { type: "completionDone", seq: 0 } }],
  };
  t.is(batchCompletionStreamResponseSchema.safeParse(response).success, true);
});
