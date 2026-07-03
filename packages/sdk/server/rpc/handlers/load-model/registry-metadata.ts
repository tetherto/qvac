import type { RegistryItem } from "@/models/registry";
import { modelDescriptorSchema } from "@/schemas";

export type ExplicitRegistryMetadata = {
  expectedSize?: number;
  sha256Checksum?: string;
};

export function getExplicitRegistryMetadata(
  modelSrc: unknown,
): ExplicitRegistryMetadata | undefined {
  const parsed = modelDescriptorSchema.safeParse(modelSrc);
  if (!parsed.success || !parsed.data.src.startsWith("registry://")) {
    return undefined;
  }

  const metadata: ExplicitRegistryMetadata = {};
  if (typeof parsed.data.expectedSize === "number") {
    metadata.expectedSize = parsed.data.expectedSize;
  }
  if (typeof parsed.data.sha256Checksum === "string") {
    metadata.sha256Checksum = parsed.data.sha256Checksum;
  }

  return metadata.expectedSize !== undefined ||
    metadata.sha256Checksum !== undefined
    ? metadata
    : undefined;
}

export function resolveRegistryDownloadMetadata(
  modelMetadata: RegistryItem | undefined,
  explicitMetadata: ExplicitRegistryMetadata | undefined,
  expectedChecksum: string | undefined,
) {
  return {
    expectedSize:
      modelMetadata?.expectedSize ?? explicitMetadata?.expectedSize ?? 0,
    checksum:
      modelMetadata?.sha256Checksum ??
      expectedChecksum ??
      explicitMetadata?.sha256Checksum ??
      "",
  };
}
