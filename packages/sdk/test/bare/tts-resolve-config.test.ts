import test from "brittle";
import { ttsConfigSchema } from "@/schemas/text-to-speech";
import { LegacyTtsModelDeprecatedError } from "@/utils/errors-server";

type TtsGgmlDebugModel = {
  _streamChunkTokens?: number;
  _streamFirstChunkTokens?: number;
  _cfmSteps?: number;
  _threads?: number;
  _nGpuLayers?: number;
  _seed?: number;
  _config?: {
    language?: string;
    useGPU?: boolean;
  };
};

test(
  "ttsPlugin resolveConfig: legacy ONNX Chatterbox shape throws LegacyTtsModelDeprecatedError",
  async (t) => {
    const { ttsPlugin } = await import("@/server/bare/plugins/tts-ggml/plugin");
    const legacyConfig = {
      ttsEngine: "chatterbox",
      language: "en",
      ttsSpeechEncoderSrc: "s3:///legacy/speech_encoder.onnx",
      ttsEmbedTokensSrc: "s3:///legacy/embed_tokens.onnx",
      ttsConditionalDecoderSrc: "s3:///legacy/conditional_decoder.onnx",
      ttsLanguageModelSrc: "s3:///legacy/language_model.onnx",
    };

    const parsed = ttsConfigSchema.safeParse(legacyConfig);
    t.is(parsed.success, true, "schema must accept legacy shape before resolveConfig");

    try {
      await ttsPlugin.resolveConfig!(legacyConfig, {
        resolveModelPath: async () => "",
        modelSrc: "s3:///legacy/model",
        modelType: "tts-ggml",
      });
      t.ok(false, "expected LegacyTtsModelDeprecatedError");
    } catch (err) {
      t.ok(
        err instanceof LegacyTtsModelDeprecatedError,
        "resolveConfig must throw LegacyTtsModelDeprecatedError for legacy ONNX config",
      );
    }
  },
);

test("ttsPlugin createModel: forwards Chatterbox native constructor options", async (t) => {
  const { ttsPlugin } = await import("@/server/bare/plugins/tts-ggml/plugin");

  const result = ttsPlugin.createModel({
    modelId: "tts-chatterbox-test",
    modelPath: "/tmp/chatterbox-t3.gguf",
    artifacts: { s3genPath: "/tmp/chatterbox-s3gen.gguf" },
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      useGPU: true,
      streamChunkTokens: 25,
      streamFirstChunkTokens: 10,
      cfmSteps: 1,
      threads: 8,
      nGpuLayers: 99,
      seed: 42,
    },
  });

  const model = result.model as TtsGgmlDebugModel;
  t.is(model._streamChunkTokens, 25);
  t.is(model._streamFirstChunkTokens, 10);
  t.is(model._cfmSteps, 1);
  t.is(model._threads, 8);
  t.is(model._nGpuLayers, 99);
  t.is(model._seed, 42);
  t.alike(model._config, { language: "en", useGPU: true });
});
