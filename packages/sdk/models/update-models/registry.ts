import { QVACRegistryClient } from "@qvac/registry-client";
import { groupShardedModels } from "./shards";
import { groupCompanionSets } from "./companions";
import { processRegistryModel } from "./processing";
import type { CollectOptions, ProcessedModel } from "./types";
import { DEFAULT_REGISTRY_CORE_KEY } from "@/constants";

// Re-export for backward compat
export {
  processRegistryModel,
  extractModelName,
  toHexString,
} from "./processing";

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
  const withCompanions = groupCompanionSets(groupedModels);

  if (noDedup) {
    console.log(`\n⏭️  Skipping deduplication (--no-dedup flag set)`);
    return withCompanions;
  }

  return deduplicateModels(withCompanions, showDuplicates);
}

export function deduplicateModels(
  models: ProcessedModel[],
  showDuplicates: boolean,
): ProcessedModel[] {
  // Paths referenced as companion files in any companion set. Dropping one of
  // these on sha256 collision would leave its companion set without a
  // standalone RegistryItem that `getModelByPath()` can resolve, causing
  // recursive registry resolutions (e.g. the Bergamot shared vocab) to fall
  // into the metadata-less fallback where `expectedSize` is `0`.
  const companionReferencedPaths = new Set<string>();
  for (const m of models) {
    if (!m.companionSet) continue;
    for (const f of m.companionSet.files) {
      companionReferencedPaths.add(`${f.registrySource}:${f.registryPath}`);
    }
  }

  const seenChecksums = new Map<string, string>();
  const dedupedModels: ProcessedModel[] = [];
  const skipped: { name: string; checksum: string; reason: string }[] = [];

  for (const model of models) {
    if (!model.sha256Checksum || model.sha256Checksum === "") {
      dedupedModels.push(model);
      continue;
    }

    if (seenChecksums.has(model.sha256Checksum)) {
      const pathKey = `${model.registrySource}:${model.registryPath}`;
      if (companionReferencedPaths.has(pathKey)) {
        dedupedModels.push(model);
        continue;
      }
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
