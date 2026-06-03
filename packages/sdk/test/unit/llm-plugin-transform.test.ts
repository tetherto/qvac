import test from "brittle";
import { transformLlmConfig } from "@/server/bare/plugins/llamacpp-completion/transform";
import { llmConfigSchema } from "@/schemas/llamacpp-config";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return llmConfigSchema.parse(overrides);
}

test("transformLlmConfig: system_prompt is never forwarded to C++", (t) => {
  const config = makeConfig({ system_prompt: "You are a helpful assistant." });
  const result = transformLlmConfig(config);
  t.absent(
    "system_prompt" in result,
    "system_prompt must not appear in C++ arg map",
  );
  t.absent(
    "system-prompt" in result,
    "hyphenated system-prompt must not appear in C++ arg map",
  );
});

test("transformLlmConfig: modelType is never forwarded to C++", (t) => {
  const config = makeConfig({});
  const result = transformLlmConfig(config);
  t.absent("modelType" in result, "modelType must not appear in C++ arg map");
  t.absent("model_type" in result);
});

test("transformLlmConfig: reasoning_budget survives as underscore key", (t) => {
  const config = makeConfig({ reasoning_budget: 0 });
  const result = transformLlmConfig(config);
  t.is(result["reasoning_budget"], "0", "reasoning_budget=0 must be forwarded as string '0'");
});

test("transformLlmConfig: reasoning_budget=-1 survives", (t) => {
  const config = makeConfig({ reasoning_budget: -1 });
  const result = transformLlmConfig(config);
  t.is(result["reasoning_budget"], "-1");
});

test("transformLlmConfig: stop_sequences is renamed to reverse_prompt", (t) => {
  const config = makeConfig({ stop_sequences: ["</s>", "<|im_end|>"] });
  const result = transformLlmConfig(config);
  t.absent("stop_sequences" in result);
  t.is(result["reverse_prompt"], "</s>, <|im_end|>");
});

test("transformLlmConfig: numeric fields are stringified", (t) => {
  const config = makeConfig({ ctx_size: 4096, gpu_layers: 99, temp: 0.7 });
  const result = transformLlmConfig(config);
  t.is(result["ctx_size"], "4096");
  t.is(result["gpu_layers"], "99");
  t.is(result["temp"], "0.7");
});
