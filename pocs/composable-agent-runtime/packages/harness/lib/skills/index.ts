import { BUNDLED_SKILLS, BUNDLED_SKILLS_HASH } from './bundled-skills.ts'
import {
  createSkillCatalogFromBundle,
  type LoadCatalogOptions,
  type SkillBundleArtifact,
  type SkillCatalogEntry
} from './catalog.ts'

export { hashBundledSkills, verifyBundledSkillsHash } from './bundled-hash.ts'
export { BUNDLED_SKILLS, BUNDLED_SKILLS_HASH } from './bundled-skills.ts'
export {
  createSkillCatalogFromBundle,
  resolveSkillCatalog,
  type SkillCatalogEntry,
  type SkillBundleArtifact,
  type SkillCatalogSource
} from './catalog.ts'
export {
  cleanupMaterializedSkills,
  createSelectedSkillsMaterializer,
  materializeSelectedSkills,
  type MaterializeSelectedSkillsOptions,
  type SelectedSkillsMaterializer
} from './materialize.ts'
export { parseToolGrant, type ToolGrant } from './tool-grants.ts'

export function bundledSkillBundle(): SkillBundleArtifact {
  return {
    files: BUNDLED_SKILLS,
    hash: BUNDLED_SKILLS_HASH
  }
}

// Platform is threaded by the caller. There is no implicit host default here:
// the harness must not assume the platform of whoever authored the bundle.
export function loadBundledSkillCatalog(
  options?: LoadCatalogOptions
): Promise<SkillCatalogEntry[]> {
  return createSkillCatalogFromBundle(
    bundledSkillBundle(),
    options?.platform === undefined ? {} : { platform: options.platform }
  )
}
