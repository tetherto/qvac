// @ts-ignore brittle has no type declarations
import test from "brittle";
import { z } from "zod";
import {
  defineHandler,
  defineDuplexHandler,
  pluginHandlerDefinitionRuntimeSchema,
} from "@/schemas/plugin";
import {
  transcribeRequestSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  type TranscribeStreamResponse,
  type TranscribeStreamSession,
} from "@/schemas/transcription";
import { createErrorResponse } from "@/schemas/error";
import { textToSpeechStreamRequestSchema } from "@/schemas/text-to-speech";

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
// defineDuplexHandler — type-safe definition without unsafe casts
// =============================================================================

test("defineDuplexHandler: returns a valid PluginHandlerDefinition with duplex flag", (t: BrittleT) => {
  const requestSchema = z.object({ modelId: z.string() });
  const responseSchema = z.object({ text: z.string() });

  const handler = defineDuplexHandler({
    requestSchema,
    responseSchema,
    streaming: true,
    duplex: true,
    handler: async function* (_request, _inputStream) {
      yield { text: "hello" };
    },
  });

  t.is(handler.streaming, true, "streaming is true");
  t.is(handler.duplex, true, "duplex is true");
  t.ok(typeof handler.handler === "function", "handler is a function");
  t.ok(handler.requestSchema === requestSchema, "requestSchema preserved");
  t.ok(handler.responseSchema === responseSchema, "responseSchema preserved");
});

test("defineDuplexHandler: handler receives inputStream as AsyncIterable<Buffer>", async (t: BrittleT) => {
  const requestSchema = z.object({ modelId: z.string() });
  const responseSchema = z.object({ text: z.string() });
  let receivedStream: AsyncIterable<Buffer> | undefined;

  const def = defineDuplexHandler({
    requestSchema,
    responseSchema,
    streaming: true,
    duplex: true,
    handler: async function* (_request, inputStream) {
      receivedStream = inputStream;
      yield { text: "ok" };
    },
  });

  const fakeStream = (async function* () {
    yield Buffer.from("audio");
  })();

  const gen = def.handler({ modelId: "test" }, fakeStream) as AsyncGenerator<{ text: string }>;
  const result = await gen.next();
  t.is(result.value?.text, "ok", "handler yields expected response");
  t.ok(receivedStream !== undefined, "inputStream was passed to handler");
});

test("defineHandler: still works for non-duplex handlers", (t: BrittleT) => {
  const requestSchema = z.object({ value: z.string() });
  const responseSchema = z.object({ ok: z.boolean() });

  const handler = defineHandler({
    requestSchema,
    responseSchema,
    streaming: false,
    handler: async function (_request) {
      return { ok: true };
    },
  });

  t.is(handler.streaming, false, "streaming is false");
  t.is(handler.duplex, undefined, "duplex is undefined for regular handlers");
});

// =============================================================================
// createErrorResponse — consistent error shape
// =============================================================================

test("createErrorResponse: produces { type: 'error' } envelope", (t: BrittleT) => {
  const response = createErrorResponse(new Error("test failure"));
  t.is(response.type, "error", "type is 'error'");
  t.ok("message" in response, "has message field");
});

test("createErrorResponse: handles non-Error values", (t: BrittleT) => {
  const response = createErrorResponse("string error");
  t.is(response.type, "error", "type is 'error' for string input");
});

// =============================================================================
// TranscribeStreamSession — destroy() interface
// =============================================================================

test("TranscribeStreamSession: interface includes destroy()", (t: BrittleT) => {
  let destroyed = false;

  const session: TranscribeStreamSession = {
    write(_chunk: Buffer) {},
    end() {},
    destroy() {
      destroyed = true;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true as const, value: undefined };
        },
      };
    },
  };

  session.destroy();
  t.ok(destroyed, "destroy() was called");
});

test("TranscribeStreamSession: destroy() tears down both streams", (t: BrittleT) => {
  let writeDestroyed = false;
  let readDestroyed = false;

  const writable = {
    write(_chunk: Buffer) {},
    end() {},
    destroy() {
      writeDestroyed = true;
    },
  };

  const readable = {
    destroy() {
      readDestroyed = true;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true as const, value: undefined };
        },
      };
    },
  };

  const session: TranscribeStreamSession = {
    write(chunk: Buffer) {
      writable.write(chunk);
    },
    end() {
      writable.end();
    },
    destroy() {
      writable.destroy();
      readable.destroy();
    },
    [Symbol.asyncIterator]() {
      return readable[Symbol.asyncIterator]();
    },
  };

  session.destroy();
  t.ok(writeDestroyed, "writable stream destroyed");
  t.ok(readDestroyed, "readable stream destroyed");
});

// =============================================================================
// Schema validation — transcribeStream schemas
// =============================================================================

test("transcribeStreamRequestSchema: validates minimal request", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "test-model",
  });
  t.ok(result.success, "valid request passes");
});

test("transcribeStreamRequestSchema: does not require audioChunk", (t: BrittleT) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "test-model",
  });
  t.ok(result.success, "request without audioChunk is valid (duplex sends audio via stream)");
});

test("transcribeStreamResponseSchema: validates response with text", (t: BrittleT) => {
  const result = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream",
    text: "hello world",
  });
  t.ok(result.success, "response with text is valid");
});

test("transcribeStreamResponseSchema: validates done response", (t: BrittleT) => {
  const result = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream",
    done: true,
  });
  t.ok(result.success, "done response is valid");
});

test("transcribeStreamResponseSchema: validates error response", (t: BrittleT) => {
  const result = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream",
    error: "model failed",
  });
  t.ok(result.success, "error response is valid");
});

// =============================================================================
// PluginHandlerDefinition — duplex flag in runtime schema
// =============================================================================

test("pluginHandlerDefinition: duplex field is optional in runtime validation", (t: BrittleT) => {
  const withoutDuplex = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: true,
    handler: () => {},
  });
  t.ok(withoutDuplex.success, "handler without duplex field is valid");

  const withDuplex = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: true,
    duplex: true,
    handler: () => {},
  });
  t.ok(withDuplex.success, "handler with duplex: true is valid");
});

// =============================================================================
// Integration: duplex session lifecycle with mock streams
// =============================================================================

function createAsyncQueue<T>() {
  const items: T[] = [];
  const waiters: ((value: T | undefined) => void)[] = [];
  let closed = false;

  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(item);
      } else {
        items.push(item);
      }
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

async function runMockDuplexHandler(
  inputBuffers: Buffer[],
  serverHandler: (
    request: Record<string, unknown>,
    inputStream: AsyncIterable<Buffer>,
  ) => AsyncGenerator<TranscribeStreamResponse>,
): Promise<string[]> {
  const inputQueue = createAsyncQueue<Buffer>();
  for (const buf of inputBuffers) inputQueue.push(buf);
  inputQueue.close();

  const request = { type: "transcribeStream", modelId: "test-model" };
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

test("duplex integration: end-to-end text segments from audio chunks", async (t: BrittleT) => {
  async function* echoHandler(
    _request: Record<string, unknown>,
    inputStream: AsyncIterable<Buffer>,
  ): AsyncGenerator<TranscribeStreamResponse> {
    let segmentIndex = 0;
    for await (const chunk of inputStream) {
      segmentIndex++;
      yield {
        type: "transcribeStream" as const,
        text: `segment-${segmentIndex}: ${chunk.length}b`,
      };
    }
    yield { type: "transcribeStream" as const, done: true };
  }

  const lines = await runMockDuplexHandler(
    [Buffer.alloc(1600), Buffer.alloc(3200)],
    echoHandler,
  );

  const segments: string[] = [];
  for (const line of lines) {
    const parsed = transcribeStreamResponseSchema.safeParse(JSON.parse(line));
    if (parsed.success && parsed.data.text) segments.push(parsed.data.text);
  }

  t.is(segments.length, 2, "received 2 text segments");
  t.ok(segments[0]!.includes("1600"), "first segment reflects first chunk size");
  t.ok(segments[1]!.includes("3200"), "second segment reflects second chunk size");
});

test("duplex integration: server error propagates as error response", async (t: BrittleT) => {
  async function* failingHandler(
    _request: Record<string, unknown>,
    _inputStream: AsyncIterable<Buffer>,
  ): AsyncGenerator<TranscribeStreamResponse> {
    yield { type: "transcribeStream" as const, text: "partial" };
    throw new Error("model crashed");
  }

  const lines = await runMockDuplexHandler([], failingHandler);

  t.ok(lines.length >= 2, "received at least text + error responses");

  const lastLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  t.is(lastLine["type"], "error", "last response is an error");
  t.ok(
    String(lastLine["message"]).includes("model crashed"),
    "error message contains original cause",
  );
});

test("duplex integration: session single-use iteration guard", async (t: BrittleT) => {
  let consumed = false;
  const fakeResponses = (async function* () {
    yield "hello";
  })();

  const session: TranscribeStreamSession = {
    write() {},
    end() {},
    destroy() {},
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error("TranscribeStreamSession can only be iterated once");
      }
      consumed = true;
      return fakeResponses;
    },
  };

  const first = session[Symbol.asyncIterator]();
  t.ok(first, "first iteration succeeds");

  let threw = false;
  try {
    session[Symbol.asyncIterator]();
  } catch {
    threw = true;
  }
  t.ok(threw, "second iteration throws");
});

test("duplex integration: line-delimited parser handles residual buffer without trailing newline", async (t: BrittleT) => {
  async function* mockStream(): AsyncIterable<Buffer> {
    yield Buffer.from(
      JSON.stringify({ type: "transcribeStream", text: "hello" }) + "\n" +
      JSON.stringify({ type: "transcribeStream", text: "world" }) + "\n" +
      JSON.stringify({ type: "transcribeStream", text: "residual" }),
    );
  }

  const texts: string[] = [];
  let buf = "";
  for await (const chunk of mockStream()) {
    buf += chunk.toString();
    const split = buf.split("\n");
    buf = split.pop() || "";
    for (const line of split) {
      if (!line.trim()) continue;
      const parsed = transcribeStreamResponseSchema.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.text) texts.push(parsed.data.text);
    }
  }
  if (buf.trim()) {
    const parsed = transcribeStreamResponseSchema.safeParse(JSON.parse(buf));
    if (parsed.success && parsed.data.text) texts.push(parsed.data.text);
  }

  t.is(texts.length, 3, "all 3 text segments captured including residual");
  t.is(texts[0], "hello", "first segment");
  t.is(texts[1], "world", "second segment");
  t.is(texts[2], "residual", "residual buffer was processed");
});

test("duplex integration: line-delimited parser handles chunked delivery across multiple yields", async (t: BrittleT) => {
  const full =
    JSON.stringify({ type: "transcribeStream", text: "first" }) + "\n" +
    JSON.stringify({ type: "transcribeStream", text: "second" }) + "\n";

  // Split in the middle of the second JSON line
  const splitAt = full.indexOf("second") - 5;

  async function* mockStream(): AsyncIterable<Buffer> {
    yield Buffer.from(full.slice(0, splitAt));
    yield Buffer.from(full.slice(splitAt));
  }

  const texts: string[] = [];
  let buf = "";
  for await (const chunk of mockStream()) {
    buf += chunk.toString();
    const split = buf.split("\n");
    buf = split.pop() || "";
    for (const line of split) {
      if (!line.trim()) continue;
      const parsed = transcribeStreamResponseSchema.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.text) texts.push(parsed.data.text);
    }
  }

  t.is(texts.length, 2, "both segments received despite mid-line split");
  t.is(texts[0], "first", "first segment intact");
  t.is(texts[1], "second", "second segment intact after reassembly");
});

// =============================================================================
// Backwards-compatible overload — schema validation for both paths
// =============================================================================

test("transcribeRequestSchema requires audioChunk (batch overload path)", (t: BrittleT) => {
  const valid = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "test-model",
    audioChunk: { type: "filePath", value: "/tmp/audio.wav" },
  });
  t.ok(valid.success, "batch request with audioChunk is valid");

  const missing = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "test-model",
  });
  t.ok(!missing.success, "batch request without audioChunk is rejected");
});

test("transcribeStreamRequestSchema does not include audioChunk (duplex overload path)", (t: BrittleT) => {
  const valid = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "test-model",
  });
  t.ok(valid.success, "duplex request without audioChunk is valid");

  const withExtra = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "test-model",
    audioChunk: { type: "filePath", value: "/tmp/audio.wav" },
  });
  t.ok(withExtra.success, "extra fields are stripped by zod");
  t.ok(!("audioChunk" in (withExtra.data ?? {})), "audioChunk absent from parsed output");
});

test("textToSpeechStreamRequestSchema accepts duplex TTS params", (t: BrittleT) => {
  const valid = textToSpeechStreamRequestSchema.safeParse({
    type: "textToSpeechStream",
    modelId: "tts-1",
    accumulateSentences: true,
    sentenceDelimiterPreset: "latin",
    flushAfterMs: 400,
  });
  t.ok(valid.success, "textToSpeechStream request is valid");
  if (valid.success) {
    t.is(valid.data.type, "textToSpeechStream");
    t.is(valid.data.accumulateSentences, true);
    t.is(valid.data.sentenceDelimiterPreset, "latin");
    t.is(valid.data.flushAfterMs, 400);
  }
});

test("duplex integration: empty/done-only handler produces no text segments", async (t: BrittleT) => {
  async function* emptyHandler(
    _request: Record<string, unknown>,
    _inputStream: AsyncIterable<Buffer>,
  ): AsyncGenerator<TranscribeStreamResponse> {
    yield { type: "transcribeStream" as const, done: true };
  }

  const lines = await runMockDuplexHandler([], emptyHandler);
  const segments: string[] = [];

  for (const line of lines) {
    const parsed = transcribeStreamResponseSchema.safeParse(JSON.parse(line));
    if (parsed.success && parsed.data.text?.trim()) {
      segments.push(parsed.data.text);
    }
  }

  t.is(segments.length, 0, "no text segments from done-only handler");
});
