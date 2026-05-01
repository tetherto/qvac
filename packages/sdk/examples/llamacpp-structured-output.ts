import {
  loadModel,
  completion,
  unloadModel,
  QWEN3_600M_INST_Q4,
} from "@qvac/sdk";

// Demonstrates per-request structured output via `responseFormat`.
// Three modes are exercised against the same model so you can eyeball the
// difference between free-form text, free-form JSON, and a strict JSON Schema.
//
// Usage:
//   bun run examples/llamacpp-structured-output.ts

const PERSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
    occupation: { type: "string" },
  },
  required: ["name", "age", "occupation"],
  additionalProperties: false,
} as const;

const HISTORY = [
  {
    role: "system",
    content:
      "You extract structured information about people from short bios. /no_think",
  },
  {
    role: "user",
    content: "Hi, I'm Alice, I'm 30 years old and I work as a data engineer.",
  },
];

// `json_object` mode only enforces that the output is *some* valid JSON object
// — it doesn't pin the keys. Small models (Qwen3-0.6B in this example) will
// often emit `{}` because that's the shortest valid completion under the
// grammar. The same gotcha is documented for OpenAI's `response_format:
// json_object`. To get useful keys you either need a stronger prompt + a
// larger model, or — better — switch to `json_schema` (mode 3 below) so the
// grammar itself forces the keys.
const JSON_OBJECT_HISTORY = [
  {
    role: "system",
    content:
      'You extract structured information about people from short bios and reply ONLY with a JSON object containing "name", "age", and "occupation". /no_think',
  },
  {
    role: "user",
    content: "Hi, I'm Alice, I'm 30 years old and I work as a data engineer.",
  },
];

// Drains the run via the canonical `events` / `final` surface and returns the
// content text. `tokenStream` / `text` / `stats` still work but are legacy and
// will be deprecated, so new code should consume `events` for streaming and
// await `final.contentText` for the aggregated result.
async function runToContent(
  run: ReturnType<typeof completion>,
): Promise<string> {
  for await (const event of run.events) {
    if (event.type === "contentDelta") process.stdout.write(event.text);
  }
  const final = await run.final;
  process.stdout.write("\n");
  return final.contentText;
}

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelType: "llm",
    onProgress: (p) =>
      process.stdout.write(`\rLoading: ${p.percentage.toFixed(1)}%`),
  });
  console.log(`\nModel loaded: ${modelId}\n`);

  console.log("--- 1. responseFormat: text (baseline, free-form) ---");
  await runToContent(
    completion({
      modelId,
      history: HISTORY,
      stream: true,
      responseFormat: { type: "text" },
    }),
  );

  console.log("\n--- 2. responseFormat: json_object (any valid JSON) ---");
  const jsonObjectOut = await runToContent(
    completion({
      modelId,
      history: JSON_OBJECT_HISTORY,
      stream: true,
      responseFormat: { type: "json_object" },
    }),
  );
  console.log("parsed:", JSON.parse(jsonObjectOut.trim()));

  console.log("\n--- 3. responseFormat: json_schema (strict shape) ---");
  const jsonSchemaOut = await runToContent(
    completion({
      modelId,
      history: HISTORY,
      stream: true,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "person",
          schema: PERSON_SCHEMA,
        },
      },
    }),
  );
  // Output is guaranteed schema-valid JSON: object with exactly
  // {name: string, age: integer, occupation: string}, no extras.
  const parsed = JSON.parse(jsonSchemaOut.trim()) as {
    name: string;
    age: number;
    occupation: string;
  };
  console.log("parsed:", parsed);
  console.log(
    "schema-valid:",
    typeof parsed.name === "string" &&
      Number.isInteger(parsed.age) &&
      typeof parsed.occupation === "string" &&
      Object.keys(parsed).sort().join(",") === "age,name,occupation",
  );

  await unloadModel({ modelId });
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
