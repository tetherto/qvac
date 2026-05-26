import { getModel } from "@/server/bare/registry/model-registry";
import { classifyRequestSchema, type ClassifyRequest, type ClassificationResult } from "@/schemas";
import { nowMs } from "@/profiling";

type ClassifierModel = {
  classify(
    image: Uint8Array,
    options?: { topK?: number; width?: number; height?: number; channels?: 3 },
  ): Promise<ClassificationResult[]>;
};

function hasClassify(model: unknown): model is ClassifierModel {
  return (
    typeof model === "object" &&
    model !== null &&
    "classify" in model &&
    typeof (model as ClassifierModel).classify === "function"
  );
}

export async function classify(
  params: ClassifyRequest,
): Promise<{ results: ClassificationResult[]; modelExecutionMs: number }> {
  const { modelId, image, topK, width, height, channels } =
    classifyRequestSchema.parse(params);

  const model = getModel(modelId);

  if (!hasClassify(model)) {
    throw new Error("Loaded model does not support classify()");
  }

  const imageBytes = Buffer.from(image, "base64");
  const opts: { topK?: number; width?: number; height?: number; channels?: 3 } = {};
  if (topK !== undefined) opts.topK = topK;
  if (width !== undefined) opts.width = width;
  if (height !== undefined) opts.height = height;
  if (channels !== undefined) opts.channels = channels;

  const modelStart = nowMs();
  const results = await model.classify(imageBytes, opts);
  const modelExecutionMs = nowMs() - modelStart;

  return { results, modelExecutionMs };
}
