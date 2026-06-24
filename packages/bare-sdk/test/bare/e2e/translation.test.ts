import test from "brittle";
import { translate, BERGAMOT_EN_FR } from "@qvac/bare-sdk";
import { loadResource, unloadAll } from "../_lib/resources.js";

// Second addon (nmtcpp) over the bare-client; en->fr is baked into the Bergamot config.
test("bare-sdk e2e: translation via the nmtcpp addon (en->fr)", async (t) => {
  t.teardown(unloadAll);

  const modelId = await loadResource("bergamot-en-fr", {
    modelSrc: BERGAMOT_EN_FR,
    modelType: "nmt",
    modelConfig: { engine: "Bergamot", from: "en", to: "fr" },
  });

  const result = translate({
    modelId,
    text: "Hello world",
    modelType: "nmt",
    stream: false,
  });

  const translated = await result.text;

  const lc = translated.toLowerCase();
  const looksFrench = ["bonjour", "monde", "salut"].some((w) => lc.includes(w));
  t.ok(looksFrench, `expected a French translation, got: "${translated}"`);
});
