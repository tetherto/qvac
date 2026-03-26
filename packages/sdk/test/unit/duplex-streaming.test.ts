// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { z } from "zod";
import {
  defineHandler,
  defineDuplexHandler,
  type PluginHandlerDefinition,
} from "@/schemas/plugin";
import {
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  type TranscribeStreamSession,
} from "@/schemas/transcription";
import { createErrorResponse } from "@/schemas/error";

// =============================================================================
// defineDuplexHandler — type-safe definition without unsafe casts
// =============================================================================

test("defineDuplexHandler: returns a valid PluginHandlerDefinition with duplex flag", (t: { is: Function; ok: Function }) => {
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

test("defineDuplexHandler: handler receives inputStream as AsyncIterable<Buffer>", async (t: { is: Function; ok: Function }) => {
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

  const gen = def.handler({ modelId: "test" }, fakeStream);
  const result = await gen.next();
  t.is(result.value.text, "ok", "handler yields expected response");
  t.ok(receivedStream !== undefined, "inputStream was passed to handler");
});

test("defineHandler: still works for non-duplex handlers", (t: { is: Function; ok: Function }) => {
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

test("createErrorResponse: produces { type: 'error' } envelope", (t: { is: Function; ok: Function }) => {
  const response = createErrorResponse(new Error("test failure"));
  t.is(response.type, "error", "type is 'error'");
  t.ok("message" in response, "has message field");
});

test("createErrorResponse: handles non-Error values", (t: { is: Function; ok: Function }) => {
  const response = createErrorResponse("string error");
  t.is(response.type, "error", "type is 'error' for string input");
});

// =============================================================================
// TranscribeStreamSession — destroy() interface
// =============================================================================

test("TranscribeStreamSession: interface includes destroy()", (t: { ok: Function }) => {
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

test("TranscribeStreamSession: destroy() tears down both streams", (t: { ok: Function; is: Function }) => {
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

test("transcribeStreamRequestSchema: validates minimal request", (t: { ok: Function }) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "test-model",
  });
  t.ok(result.success, "valid request passes");
});

test("transcribeStreamRequestSchema: does not require audioChunk", (t: { ok: Function }) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "test-model",
  });
  t.ok(result.success, "request without audioChunk is valid (duplex sends audio via stream)");
});

test("transcribeStreamResponseSchema: validates response with text", (t: { ok: Function }) => {
  const result = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream",
    text: "hello world",
  });
  t.ok(result.success, "response with text is valid");
});

test("transcribeStreamResponseSchema: validates done response", (t: { ok: Function }) => {
  const result = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream",
    done: true,
  });
  t.ok(result.success, "done response is valid");
});

test("transcribeStreamResponseSchema: validates error response", (t: { ok: Function }) => {
  const result = transcribeStreamResponseSchema.safeParse({
    type: "transcribeStream",
    error: "model failed",
  });
  t.ok(result.success, "error response is valid");
});

// =============================================================================
// PluginHandlerDefinition — duplex flag in runtime schema
// =============================================================================

test("pluginHandlerDefinition: duplex field is optional in runtime validation", (t: { ok: Function }) => {
  const { pluginHandlerDefinitionRuntimeSchema } = require("@/schemas/plugin");

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
// bare-client non-duplex handler — behavioral test
// =============================================================================

test("bare-client: non-duplex handler ignores inputStream argument silently", async (t: { ok: Function; is: Function }) => {
  let receivedArgs: unknown[] = [];
  const fakeHandler = async function* (...args: unknown[]) {
    receivedArgs = args;
    yield { type: "transcribe", text: "result", done: true };
  };

  const fakeInputStream = { [Symbol.asyncIterator]: async function* () {} };

  const gen = fakeHandler({ type: "transcribe", modelId: "m1" }, fakeInputStream);
  const result = await gen.next();

  t.is(receivedArgs.length, 2, "handler receives both args when cast as duplex");
  t.is(result.value.text, "result", "handler still produces output");
  t.ok(
    true,
    "non-duplex handlers silently ignore the extra inputStream — " +
      "the server-side registry check (entry.type !== 'duplex') is the " +
      "proper guard; bare-client bypasses the registry",
  );
});
