// @ts-ignore brittle has no type declarations
import test from "brittle";
import {
  transcribeRequestSchema,
  transcribeStreamRequestSchema,
  transcribeResponseSchema,
  transcribeStreamResponseSchema,
  transcribeSegmentSchema,
  type TranscribeSegment,
  type TranscribeStreamResponse,
} from "@/schemas/transcription";
import { ModelType } from "@/schemas/model-types";
import { createErrorResponse } from "@/schemas/error";
import {
  toTranscribeSegment,
  assertMetadataSupported,
} from "@/server/bare/utils/transcribe-metadata";
import { TranscriptionFailedError } from "@/utils/errors-server";

type BrittleT = {
  is: Function;
  ok: Function;
  exception: Function;
  execution: Function;
  not: Function;
  alike: Function;
  teardown: Function;
};

// =============================================================================
// Schema round-trip — transcribeSegmentSchema / transcribeResponseSchema
// =============================================================================

test("transcribeSegmentSchema: accepts a well-formed segment", (t: BrittleT) => {
  const result = transcribeSegmentSchema.safeParse({
    text: "hello world",
    startMs: 1200,
    endMs: 2400,
    append: false,
    id: 3,
  });
  t.ok(result.success, "well-formed segment is valid");
});

test("transcribeSegmentSchema: rejects missing fields", (t: BrittleT) => {
  const missingText = transcribeSegmentSchema.safeParse({
    startMs: 0,
    endMs: 1000,
    append: false,
    id: 0,
  });
  t.ok(!missingText.success, "segment without text is rejected");

  const missingTiming = transcribeSegmentSchema.safeParse({
    text: "hi",
    append: false,
    id: 0,
  });
  t.ok(!missingTiming.success, "segment without startMs/endMs is rejected");

  const wrongTypes = transcribeSegmentSchema.safeParse({
    text: "hi",
    startMs: "0",
    endMs: 1000,
    append: false,
    id: 0,
  });
  t.ok(!wrongTypes.success, "non-number timing is rejected");
});

test("transcribeResponseSchema: round-trips a segment payload", (t: BrittleT) => {
  const segment: TranscribeSegment = {
    text: "round trip",
    startMs: 500,
    endMs: 1500,
    append: true,
    id: 7,
  };
  const wire = {
    type: "transcribe" as const,
    segment,
  };
  const parsed = transcribeResponseSchema.safeParse(wire);
  t.ok(parsed.success, "wire frame with segment is valid");
  if (parsed.success) {
    t.alike(parsed.data.segment, segment, "segment survives parse");
    t.is(parsed.data.text, undefined, "text is not populated on segment frames");
  }
});

test("transcribeStreamResponseSchema: round-trips a segment payload", (t: BrittleT) => {
  const segment: TranscribeSegment = {
    text: "stream seg",
    startMs: 100,
    endMs: 900,
    append: false,
    id: 1,
  };
  const parsed = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream" as const,
    segment,
  });
  t.ok(parsed.success, "duplex wire frame with segment is valid");
  if (parsed.success) t.alike(parsed.data.segment, segment, "segment preserved");
});

test("transcribeResponseSchema: done frame can still omit segment", (t: BrittleT) => {
  const parsed = transcribeResponseSchema.safeParse({
    type: "transcribe",
    text: "",
    done: true,
  });
  t.ok(parsed.success, "terminal done frame without segment is still valid");
});

// =============================================================================
// Schema round-trip — metadata flag on request schemas
// =============================================================================

test("transcribeRequestSchema: accepts metadata: true", (t: BrittleT) => {
  const result = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "m",
    audioChunk: { type: "filePath", value: "/tmp/a.wav" },
    metadata: true,
  });
  t.ok(result.success, "request with metadata: true parses");
  if (result.success) t.is(result.data.metadata, true, "metadata preserved");
});

test("transcribeRequestSchema: metadata remains optional", (t: BrittleT) => {
  const result = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "m",
    audioChunk: { type: "filePath", value: "/tmp/a.wav" },
  });
  t.ok(result.success, "request without metadata parses");
  if (result.success) t.is(result.data.metadata, undefined, "metadata absent");
});

test("transcribeRequestSchema: rejects non-boolean metadata", (t: BrittleT) => {
  const result = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "m",
    audioChunk: { type: "filePath", value: "/tmp/a.wav" },
    metadata: "yes",
  });
  t.ok(!result.success, "non-boolean metadata is rejected");
});

test("transcribeStreamRequestSchema: accepts metadata: true", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m",
    metadata: true,
  });
  t.ok(result.success, "duplex request with metadata: true parses");
  if (result.success) t.is(result.data.metadata, true, "metadata preserved");
});

// =============================================================================
// toTranscribeSegment — seconds → ms, defaults for missing fields
// =============================================================================

test("toTranscribeSegment: converts seconds to milliseconds", (t: BrittleT) => {
  const segment = toTranscribeSegment({
    text: "hello",
    start: 1.25,
    end: 2.5,
    toAppend: true,
    id: 42,
  });
  t.is(segment.text, "hello", "text passes through");
  t.is(segment.startMs, 1250, "start 1.25s → 1250ms");
  t.is(segment.endMs, 2500, "end 2.5s → 2500ms");
  t.is(segment.append, true, "toAppend → append");
  t.is(segment.id, 42, "id passes through");
});

test("toTranscribeSegment: handles zero-second boundaries", (t: BrittleT) => {
  const segment = toTranscribeSegment({
    text: "",
    start: 0,
    end: 0,
    toAppend: false,
    id: 0,
  });
  t.is(segment.startMs, 0, "start 0 → 0ms");
  t.is(segment.endMs, 0, "end 0 → 0ms");
  t.is(segment.append, false, "append false");
  t.is(segment.id, 0, "id 0");
});

test("toTranscribeSegment: defaults missing optional fields", (t: BrittleT) => {
  const segment = toTranscribeSegment({ text: "hi" });
  t.is(segment.startMs, 0, "missing start defaults to 0ms");
  t.is(segment.endMs, 0, "missing end defaults to 0ms");
  t.is(segment.append, false, "missing toAppend defaults to false");
  t.is(segment.id, 0, "missing id defaults to 0");
});

test("toTranscribeSegment: fractional seconds round-trip through * 1000", (t: BrittleT) => {
  const segment = toTranscribeSegment({
    text: "x",
    start: 0.123,
    end: 0.456,
  });
  t.is(segment.startMs, 123, "0.123s → 123ms");
  t.is(segment.endMs, 456, "0.456s → 456ms");
});

test("toTranscribeSegment: output validates against transcribeSegmentSchema", (t: BrittleT) => {
  const segment = toTranscribeSegment({
    text: "schema-check",
    start: 1,
    end: 2,
    toAppend: false,
    id: 9,
  });
  const parsed = transcribeSegmentSchema.safeParse(segment);
  t.ok(parsed.success, "normalizer output is schema-valid");
});

// =============================================================================
// assertMetadataSupported — engine guard
// =============================================================================

test("assertMetadataSupported: no-op when metadata is falsy", (t: BrittleT) => {
  t.execution(() => {
    assertMetadataSupported("m", ModelType.parakeetTranscription, false);
  }, "metadata=false does not throw for any engine");
  t.execution(() => {
    assertMetadataSupported("m", ModelType.parakeetTranscription, undefined);
  }, "metadata=undefined does not throw for any engine");
});

test("assertMetadataSupported: passes for whisper engine", (t: BrittleT) => {
  t.execution(() => {
    assertMetadataSupported("m", ModelType.whispercppTranscription, true);
  }, "metadata=true on whisper does not throw");
});

test("assertMetadataSupported: throws TranscriptionFailedError for parakeet", (t: BrittleT) => {
  let caught: unknown;
  try {
    assertMetadataSupported("my-model", ModelType.parakeetTranscription, true);
  } catch (err) {
    caught = err;
  }
  t.ok(caught instanceof TranscriptionFailedError, "throws TranscriptionFailedError");
  t.ok(
    String((caught as Error).message).includes("metadata"),
    "error message mentions metadata",
  );
  t.ok(
    String((caught as Error).message).includes("my-model"),
    "error message includes offending model id",
  );
});

test("assertMetadataSupported: throws for unknown / empty engine", (t: BrittleT) => {
  let caught: unknown;
  try {
    assertMetadataSupported("m", "", true);
  } catch (err) {
    caught = err;
  }
  t.ok(caught instanceof TranscriptionFailedError, "empty engine rejected");
});

// =============================================================================
// Integration: duplex session yielding metadata segments end-to-end
// =============================================================================

function createAsyncQueue<T>() {
  const items: T[] = [];
  const waiters: ((value: T | undefined) => void)[] = [];
  let closed = false;

  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    close() {
      closed = true;
      for (const w of waiters) w(undefined);
      waiters.length = 0;
    },
    async *iterate(): AsyncGenerator<T> {
      while (true) {
        if (items.length > 0) {
          yield items.shift()!;
        } else if (closed) {
          return;
        } else {
          const item = await new Promise<T | undefined>((resolve) => {
            waiters.push(resolve);
          });
          if (item === undefined) return;
          yield item;
        }
      }
    },
  };
}

async function runMockDuplexMetadataHandler(
  inputBuffers: Buffer[],
  serverHandler: (
    request: Record<string, unknown>,
    inputStream: AsyncIterable<Buffer>,
  ) => AsyncGenerator<TranscribeStreamResponse>,
): Promise<string[]> {
  const inputQueue = createAsyncQueue<Buffer>();
  for (const buf of inputBuffers) inputQueue.push(buf);
  inputQueue.close();

  const request = {
    type: "transcribeStream",
    modelId: "test-model",
    metadata: true,
  };
  const outputLines: string[] = [];

  try {
    for await (const response of serverHandler(request, inputQueue.iterate())) {
      outputLines.push(JSON.stringify(response));
    }
  } catch (error) {
    outputLines.push(JSON.stringify(createErrorResponse(error)));
  }

  return outputLines;
}

test("duplex metadata integration: end-to-end segments from audio chunks", async (t: BrittleT) => {
  async function* segmentHandler(
    _request: Record<string, unknown>,
    inputStream: AsyncIterable<Buffer>,
  ): AsyncGenerator<TranscribeStreamResponse> {
    let idx = 0;
    let tCursor = 0;
    for await (const chunk of inputStream) {
      idx++;
      const addonSegment = {
        text: `segment-${idx}`,
        start: tCursor,
        end: tCursor + chunk.length / 16000,
        toAppend: idx > 1,
        id: idx,
      };
      tCursor += chunk.length / 16000;
      yield {
        type: "transcribeStream" as const,
        segment: toTranscribeSegment(addonSegment),
      };
    }
    yield { type: "transcribeStream" as const, done: true };
  }

  const lines = await runMockDuplexMetadataHandler(
    [Buffer.alloc(1600), Buffer.alloc(3200)],
    segmentHandler,
  );

  const segments: TranscribeSegment[] = [];
  for (const line of lines) {
    const parsed = transcribeStreamResponseSchema.safeParse(JSON.parse(line));
    if (parsed.success && parsed.data.segment) segments.push(parsed.data.segment);
  }

  t.is(segments.length, 2, "received 2 segment frames");
  t.is(segments[0]!.text, "segment-1", "first segment text");
  t.is(segments[0]!.id, 1, "first segment id");
  t.is(segments[0]!.append, false, "first segment append=false");
  t.is(segments[0]!.startMs, 0, "first segment startMs is 0");
  t.is(segments[1]!.text, "segment-2", "second segment text");
  t.is(segments[1]!.id, 2, "second segment id");
  t.is(segments[1]!.append, true, "second segment append=true");
  t.ok(segments[1]!.startMs > 0, "second segment startMs advanced");
  t.ok(
    segments[1]!.endMs > segments[1]!.startMs,
    "second segment endMs > startMs",
  );
});

test("duplex metadata integration: line-delimited parser round-trips segment frames", async (t: BrittleT) => {
  const frames: TranscribeStreamResponse[] = [
    {
      type: "transcribeStream",
      segment: {
        text: "first",
        startMs: 0,
        endMs: 500,
        append: false,
        id: 1,
      },
    },
    {
      type: "transcribeStream",
      segment: {
        text: "second",
        startMs: 500,
        endMs: 1000,
        append: true,
        id: 2,
      },
    },
    { type: "transcribeStream", done: true },
  ];

  const wire = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";

  async function* mockStream(): AsyncIterable<Buffer> {
    const splitAt = wire.indexOf("second") - 3;
    yield Buffer.from(wire.slice(0, splitAt));
    yield Buffer.from(wire.slice(splitAt));
  }

  const segments: TranscribeSegment[] = [];
  let sawDone = false;
  let buf = "";
  for await (const chunk of mockStream()) {
    buf += chunk.toString();
    const split = buf.split("\n");
    buf = split.pop() || "";
    for (const line of split) {
      if (!line.trim()) continue;
      const parsed = transcribeStreamResponseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      if (parsed.data.segment) segments.push(parsed.data.segment);
      if (parsed.data.done) sawDone = true;
    }
  }

  t.is(segments.length, 2, "both segments reassembled across chunk boundary");
  t.is(segments[0]!.text, "first", "first segment intact");
  t.is(segments[1]!.text, "second", "second segment intact");
  t.ok(sawDone, "done frame observed");
});
