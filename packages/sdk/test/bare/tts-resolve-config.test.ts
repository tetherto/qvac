import test from "brittle";
import { ttsConfigSchema } from "@/schemas/text-to-speech";
import { LegacyTtsModelDeprecatedError } from "@/utils/errors-server";

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
        modelType: "tts",
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
