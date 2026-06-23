import test from "brittle";
import { completion, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/bare-sdk";
import { loadResource, unloadAll } from "../_lib/resources.js";

// bare-client token-stream shape. temp 0 + fixed seed keeps the assertion
// reproducible.
test("bare-sdk e2e: completion over the token stream (deterministic)", async (t) => {
  t.teardown(unloadAll);

  const modelId = await loadResource("llm", {
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: { ctx_size: 2048 },
  });

  const run = completion({
    modelId,
    history: [
      { role: "user", content: "What is 2+2? Answer with only the number." },
    ],
    stream: true,
    generationParams: { temp: 0, seed: 42 },
  });

  let text = "";
  for await (const token of run.tokenStream) {
    text += token;
  }

  t.ok(text.includes("4"), `expected "4" in completion output, got: "${text}"`);
});
