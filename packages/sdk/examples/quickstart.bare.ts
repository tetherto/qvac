// The Bare quickstart. Bare has no `process` global and does not spawn a worker,
// so two setup steps come first: install bare-process as the `process` global,
// then register the plugins this example uses via `plugins([...])`.

import bareProcess from "bare-process";
import { plugins, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";
import { llmPlugin } from "@qvac/sdk/llamacpp-completion/plugin";

(globalThis as unknown as { process: typeof bareProcess }).process = bareProcess;

const { loadModel, completion, unloadModel } = plugins([llmPlugin]);

// From here it is the same as the Node quickstart.
const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });

const history = [
  { role: "user", content: "Explain quantum computing in one sentence" },
];
const result = completion({ modelId, history, stream: true });
for await (const token of result.tokenStream) {
  process.stdout.write(token);
}

await unloadModel({ modelId, autoClose: true });
