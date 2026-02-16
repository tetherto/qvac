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

export function processRegistryModel(
  model: QVACModelEntry,
): ProcessedModel | null {
  const engine = resolveCanonicalEngine(model.engine);
  if (!engine) {
    console.warn(
      `⚠️  Skipping model with unknown engine "${model.engine}": ${model.path}`,
    );
    return null;
  }

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
