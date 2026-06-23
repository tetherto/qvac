import test from "brittle";
import { completion } from "@qvac/bare-sdk";

// Model-free gate: an SDK call before registerPlugin() must fail fast, not hang.
test("bare-sdk: SDK call before registerPlugin fails fast (plugins not registered)", async (t) => {
  const run = completion({
    modelId: "no-such-model",
    history: [{ role: "user", content: "hi" }],
    stream: false,
  });

  // Match the message, not the class: WorkerPluginsNotRegisteredError isn't
  // re-exported from the root entry.
  await t.exception(run.text, /plugin/i);
});
