import { QVACRegistryClient } from "@qvac/registry-client";
import { groupShardedModels } from "./shards";
import { processRegistryModel } from "./processing";
import type { CollectOptions, ProcessedModel } from "./types";

// Re-export for backward compat
export {
  processRegistryModel,
  extractModelName,
  toHexString,
} from "./processing";

const DEFAULT_REGISTRY_CORE_KEY =
  "u6pq8h3kof7ck9g6kjusykfxaxqaqtnoydq15hhyuzrf55nt384y";

export async function collectModels(
  options: CollectOptions = {},
): Promise<ProcessedModel[]> {
  const { showDuplicates = false, noDedup = false } = options;
  const models: ProcessedModel[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const registryCoreKey: string =
    process.env["QVAC_REGISTRY_CORE_KEY"] ?? DEFAULT_REGISTRY_CORE_KEY;
  const client = new QVACRegistryClient({ registryCoreKey });

  try {
    await client.ready();

    const registryModels = await client.findModels({});

    console.log(`📦 Found ${registryModels.length} entries in registry`);

    for (const registryModel of registryModels) {
      const processed = processRegistryModel(registryModel);
      if (processed) models.push(processed);
    }
  } finally {
    await client.close();
  }

  const groupedModels = groupShardedModels(models);

  if (noDedup) {
    console.log(`\n⏭️  Skipping deduplication (--no-dedup flag set)`);
    return groupedModels;
  }

  return deduplicateModels(groupedModels, showDuplicates);
}

function deduplicateModels(
  models: ProcessedModel[],
  showDuplicates: boolean,
): ProcessedModel[] {
  const seenChecksums = new Map<string, string>();
  const dedupedModels: ProcessedModel[] = [];
  const skipped: { name: string; checksum: string; reason: string }[] = [];

  for (const model of models) {
    if (!model.sha256Checksum || model.sha256Checksum === "") {
      dedupedModels.push(model);
      continue;
    }

    if (seenChecksums.has(model.sha256Checksum)) {
      skipped.push({
        name: model.registryPath,
        checksum: model.sha256Checksum,
        reason: `Duplicate of ${seenChecksums.get(model.sha256Checksum)}`,
      });
      continue;
    }

    seenChecksums.set(model.sha256Checksum, model.registryPath);
    dedupedModels.push(model);
  }

  if (skipped.length > 0) {
    console.log(`\n🧹 Removed ${skipped.length} duplicate model(s)`);
    if (showDuplicates) {
      skipped.forEach(({ name, checksum, reason }) => {
        console.log(`  - ${name}`);
        console.log(`    Checksum: ${checksum}`);
        console.log(`    ${reason}`);
      });
    } else {
      console.log(`   Use --show-duplicates to see details`);
    }
  }

  return dedupedModels;
}
