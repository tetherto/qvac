// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { loadModelSrcRequestSchema } from "@/schemas/load-model";
import { ModelType } from "@/schemas";

test("loadModelSrcRequestSchema: rejects unknown top-level keys", (t) => {
  const invalidRequest = {
    type: "loadModel",
    modelType: ModelType.llamacppCompletion,
    modelSrc: "model.gguf",
    modelConfig: {},
    unknownTopLevelField: "should-fail",
  };

  const result = loadModelSrcRequestSchema.safeParse(invalidRequest);
  t.is(result.success, false);
});

test("loadModelSrcRequestSchema: accepts companion sources inside modelConfig", (t) => {
  const validWhisperRequest = {
    type: "loadModel",
    modelType: ModelType.whispercppTranscription,
    modelSrc: "model.bin",
    modelConfig: {
      language: "en",
      vadModelSrc: "vad.bin",
    },
  };

  const validOcrRequest = {
    type: "loadModel",
    modelType: ModelType.onnxOcr,
    modelSrc: "recognizer.onnx",
    modelConfig: {
      detectorModelSrc: "detector.onnx",
    },
  };

  t.is(loadModelSrcRequestSchema.safeParse(validWhisperRequest).success, true);
  t.is(loadModelSrcRequestSchema.safeParse(validOcrRequest).success, true);
});

test("loadModelSrcRequestSchema: accepts classification load with empty modelSrc (bundled weights)", (t) => {
  // Classification ships bundled GGUF weights, so callers can omit modelSrc.
  // The client-side transform produces modelSrc: "" in that case; the server
  // schema must accept it without falling through to the custom-plugin arm.
  const bundledLoad = {
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "",
    modelConfig: {},
  };

  const bundledWithTopK = {
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "",
    modelConfig: { topK: 3 },
  };

  const customGguf = {
    type: "loadModel",
    modelType: ModelType.ggmlClassification,
    modelSrc: "/path/to/my-classifier.gguf",
    modelConfig: {},
  };

  t.is(loadModelSrcRequestSchema.safeParse(bundledLoad).success, true);
  t.is(loadModelSrcRequestSchema.safeParse(bundledWithTopK).success, true);
  t.is(loadModelSrcRequestSchema.safeParse(customGguf).success, true);
});

test("loadModelRequestSchema: custom plugin allows unknown modelConfig keys", (t) => {
  const customPluginRequest = {
    type: "loadModel",
    modelType: "my-custom-plugin",
    modelSrc: "model.bin",
    modelConfig: {
      customOption1: "value1",
      customOption2: 123,
      nestedConfig: { deep: true },
    },
  };

  const result = loadModelSrcRequestSchema.safeParse(customPluginRequest);
  t.is(result.success, true);
  if (result.success) {
    t.is(
      (result.data.modelConfig as Record<string, unknown>)?.customOption1,
      "value1",
    );
  }
});
