import type { QVACModelEntry } from "@qvac/registry-client";
import {
  getAddonFromEngine,
  resolveCanonicalEngine,
} from "../../schemas/engine-addon-map";
import { detectShardedModel } from "./shards";
import type { ProcessedModel } from "./types";

export function toHexString(
  value: Buffer | string | { data: number[] } | undefined,
): string {
  if (!value) return "";
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "string") return value;
  if (typeof value === "object" && "data" in value) {
    return Buffer.from(value.data).toString("hex");
  }
  return "";
}

export function extractModelName(registryPath: string): string {
  const parts = registryPath.split("/");
  if (parts.length >= 2) {
    return parts[1] || parts[0] || "";
  }
  return (
    registryPath
      .split("/")
      .pop()
      ?.replace(/\.\w+$/, "") || ""
  );
}

// Keeps the prior `tts` entries discoverable on the public surface even though
// the new GGML plugin can't load them. Stamping them with `onnx-tts` (already
// in `modelRegistryEngineSchema`) means consumers picking these constants see
// an explicit "modelType invalid" error from `loadModel` schema validation
// rather than an opaque C++ parse failure inside the GGML addon.
function isDeadOnnxTtsEntry(
  rawEngine: string,
  canonicalEngine: string,
  registryPath: string,
): boolean {
  if (canonicalEngine !== "ggml-tts") return false;
  // Anything from the prior `tts-onnx` namespace is suspect; the new addon
  // only knows how to load `.gguf` files.
  const wasTtsLabel =
    rawEngine === "@qvac/tts-onnx" ||
    rawEngine === "@qvac/tts" ||
    rawEngine === "tts" ||
    rawEngine === "onnx-tts" ||
    rawEngine === "ggml-tts" ||
    rawEngine === "@qvac/tts-ggml";
  if (!wasTtsLabel) return false;
  return !registryPath.toLowerCase().endsWith(".gguf");
}

export function processRegistryModel(
  model: QVACModelEntry,
): ProcessedModel | null {
  const resolved = resolveCanonicalEngine(model.engine);
  if (!resolved) {
    console.warn(
      `⚠️  Skipping model with unknown engine "${model.engine}": ${model.path}`,
    );
    return null;
  }

  const engine = isDeadOnnxTtsEntry(model.engine, resolved, model.path)
    ? "onnx-tts"
    : resolved;

  const filename = model.path.split("/").pop() || model.path;
  const blobBinding = model.blobBinding;

  const blobCoreKey = toHexString(blobBinding?.coreKey);
  const blobBlockOffset = blobBinding?.blockOffset ?? 0;
  const blobBlockLength = blobBinding?.blockLength ?? 0;
  const blobByteOffset = blobBinding?.byteOffset ?? 0;
  const expectedSize = blobBinding?.byteLength ?? 0;
  // The sha256 lives on blobBinding at runtime (per the hyperschema),
  // even though the TS types define it on QVACModelEntry. Try blobBinding first.
  const sha256Checksum =
    (blobBinding as unknown as Record<string, string>)?.["sha256"] ||
    model.sha256 ||
    "";

  const addon = getAddonFromEngine(engine);

  const result: ProcessedModel = {
    registryPath: model.path,
    registrySource: model.source,
    blobCoreKey,
    blobBlockOffset,
    blobBlockLength,
    blobByteOffset,
    modelId: filename,
    addon,
    expectedSize,
    sha256Checksum,
    engine,
    modelName: extractModelName(model.path),
    quantization: model.quantization || "",
    params: model.params || "",
    tags: model.tags || [],
  };

  const shardDetection = detectShardedModel(filename);
  if (shardDetection.isSharded) {
    result.isShardPart = true;
    result.shardInfo = shardDetection;
  }

  return result;
}
