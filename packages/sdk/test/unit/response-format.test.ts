// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  responseFormatSchema,
  completionClientParamsSchema,
} from "@/schemas/completion-stream";
import { getResponseFormatJsonSchema } from "@/server/utils/response-format";

test("responseFormatSchema: accepts text", (t) => {
  t.is(responseFormatSchema.safeParse({ type: "text" }).success, true);
});

test("responseFormatSchema: accepts json_object", (t) => {
  t.is(responseFormatSchema.safeParse({ type: "json_object" }).success, true);
});

test("responseFormatSchema: accepts json_schema with required fields", (t) => {
  const result = responseFormatSchema.safeParse({
    type: "json_schema",
    json_schema: {
      name: "Person",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
        required: ["name"],
      },
    },
  });
  t.is(result.success, true);
});

test("responseFormatSchema: rejects unknown type", (t) => {
  const result = responseFormatSchema.safeParse({ type: "yaml" });
  t.is(result.success, false);
});

test("responseFormatSchema: rejects json_schema without name", (t) => {
  const result = responseFormatSchema.safeParse({
    type: "json_schema",
    json_schema: { schema: { type: "object" } },
  });
  t.is(result.success, false);
});

test("responseFormatSchema: rejects json_schema with empty name", (t) => {
  const result = responseFormatSchema.safeParse({
    type: "json_schema",
    json_schema: { name: "", schema: { type: "object" } },
  });
  t.is(result.success, false);
});

test("completionClientParamsSchema: rejects responseFormat together with tools", (t) => {
  const result = completionClientParamsSchema.safeParse({
    modelId: "test",
    history: [{ role: "user", content: "hi" }],
    stream: false,
    tools: [
      {
        type: "function",
        name: "echo",
        description: "Echo input",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "P", schema: { type: "object" } },
    },
  });
  t.is(result.success, false);
});

test("completionClientParamsSchema: allows responseFormat without tools", (t) => {
  const result = completionClientParamsSchema.safeParse({
    modelId: "test",
    history: [{ role: "user", content: "hi" }],
    stream: false,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "P", schema: { type: "object" } },
    },
  });
  t.is(result.success, true);
});

test("completionClientParamsSchema: allows tools without responseFormat", (t) => {
  const result = completionClientParamsSchema.safeParse({
    modelId: "test",
    history: [{ role: "user", content: "hi" }],
    stream: false,
    tools: [
      {
        type: "function",
        name: "echo",
        description: "Echo input",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
  });
  t.is(result.success, true);
});

test("completionClientParamsSchema: text responseFormat is allowed alongside tools", (t) => {
  const result = completionClientParamsSchema.safeParse({
    modelId: "test",
    history: [{ role: "user", content: "hi" }],
    stream: false,
    tools: [
      {
        type: "function",
        name: "echo",
        description: "Echo input",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    responseFormat: { type: "text" },
  });
  t.is(result.success, true);
});

test("getResponseFormatJsonSchema: text returns undefined", (t) => {
  t.is(getResponseFormatJsonSchema({ type: "text" }), undefined);
});

test("getResponseFormatJsonSchema: json_object returns the permissive object schema", (t) => {
  const result = getResponseFormatJsonSchema({ type: "json_object" });
  t.is(typeof result, "string");
  t.alike(JSON.parse(result as string), { type: "object" });
});

test("getResponseFormatJsonSchema: json_schema returns the schema verbatim", (t) => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  const result = getResponseFormatJsonSchema({
    type: "json_schema",
    json_schema: { name: "P", schema },
  });
  t.is(typeof result, "string");
  t.alike(JSON.parse(result as string), schema);
});
