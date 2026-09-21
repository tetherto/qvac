// Type-level consumer test mirroring the SDK's import shapes, compiled with
// the SDK's module settings. Type-checked only — never executed.
import LlmLlamacpp, { pickPrimaryGgufPath } from "../../index";
import type { GenerationParams, RunOptions, Message, BatchPrompt, QvacResponse } from "../../index";
import llmAddonLogging, {
  setLogger,
  releaseLogger,
  type AddonLogging,
} from "../../addonLogging";

const model = new LlmLlamacpp({
  files: { model: ["/abs/model.gguf"], projectionModel: "/abs/mmproj.gguf" },
  config: { device: "gpu" },
  logger: null,
  opts: { stats: true, rejectWhenBusy: false },
});

const generationParams: GenerationParams = { temp: 0.2, top_p: 0.9 };
const runOptions: RunOptions = { generationParams, rejectWhenBusy: true };
const prompt: Message[] = [{ role: "user", content: "hi" }];
const batch: (Message[] | BatchPrompt)[] = [prompt, { prompt, runOptions }];

async function sdkShapes() {
  // ops/completion-stream.ts and ops/translate.ts consume these types.
  const response = await model.run(prompt, runOptions);
  for await (const chunk of response.iterate()) {
    void chunk;
  }
  await response.cancel();

  const batched = await model.run(batch);
  batched.on("output", (chunk) => {
    void chunk.id;
    void chunk.chunk;
  });

  await model.addon?.cancelJob(1);
  await model.unload();
}
void sdkShapes;

// Upstream exposed `QvacResponse` as a top-level named type export; it must
// stay importable that way, not only as `LlmLlamacpp.QvacResponse`.
declare const response: QvacResponse;
void response;

const primary: string = pickPrimaryGgufPath(["/abs/model.gguf"]);
void primary;

const logging: AddonLogging = llmAddonLogging;
logging.setLogger((priority: number, message: string) => {
  void priority;
  void message;
});
logging.releaseLogger();
setLogger((priority: number, message: string) => {
  void priority;
  void message;
});
releaseLogger();

interface PluginModel {
  load(force?: boolean): Promise<void>;
  unload?(): void | Promise<void>;
}
const pluginModel: PluginModel = model;
void pluginModel;

// `| null` is spelled out because this fixture sets `exactOptionalPropertyTypes`.
interface AddonInterface {
  cancel(jobId?: string): Promise<void>;
}
interface AnyModel {
  load(force?: boolean): Promise<void>;
  unload(): void | Promise<void>;
  pause(): void | Promise<void>;
  addon?: AddonInterface | null;
}
const anyModel: AnyModel = model;
void anyModel;
