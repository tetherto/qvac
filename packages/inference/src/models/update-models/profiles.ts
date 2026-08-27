import type { ModelResourceProfile, ProcessedModel } from './types'

/**
 * Builds the pre-download resource profile for one catalog entry.
 *
 * The profile carries only facts: what lands on disk, and the transformer shape
 * from the GGUF metadata when the registry captured it. Interpreting those into
 * a memory estimate is the estimators' job, so re-calibrating an estimator
 * never requires regenerating the catalog.
 *
 * @param model - A processed registry model, after shard grouping and companion
 *   detection (so `expectedSize` already totals a sharded model's parts).
 * @returns The profile for this entry.
 */
export function buildResourceProfile(model: ProcessedModel): ModelResourceProfile {
  const assumptions: string[] = []

  // A companion set's `files` array includes the primary, so summing it is the
  // whole on-disk footprint. Sharded models are already summed into
  // `expectedSize` by `groupShardedModels`.
  let artifactBytes = model.expectedSize
  if (model.companionSet) {
    artifactBytes = model.companionSet.files.reduce((sum, file) => sum + file.expectedSize, 0)
    assumptions.push(`artifactBytes sums ${model.companionSet.files.length} companion-set files`)
  } else if (model.shardMetadata) {
    assumptions.push(`artifactBytes sums ${model.shardMetadata.length} shards`)
  }

  const profile: ModelResourceProfile = {
    schemaVersion: 1,
    engine: model.engine,
    artifactBytes
  }

  if (model.ggufFacts) profile.ggufFacts = model.ggufFacts
  if (assumptions.length > 0) profile.assumptions = assumptions

  return profile
}

/**
 * Builds the checksum-keyed profile table for the whole catalog.
 *
 * Entries without a checksum are skipped: the checksum is what a caller holds
 * from a model constant, so an entry that has none cannot be looked up. On a
 * checksum collision the first entry wins, matching the catalog's own dedup
 * order.
 *
 * @param models - Every processed model in the catalog, companion-only entries
 *   included (they are addressable by checksum too).
 * @returns Profiles keyed by `sha256Checksum`.
 */
export function buildResourceProfiles(
  models: ProcessedModel[]
): Record<string, ModelResourceProfile> {
  const profiles: Record<string, ModelResourceProfile> = {}

  for (const model of models) {
    const key = model.sha256Checksum
    if (!key) continue
    if (profiles[key]) continue
    profiles[key] = buildResourceProfile(model)
  }

  return profiles
}
