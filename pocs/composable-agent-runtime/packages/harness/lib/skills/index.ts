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
  type SkillCatalogEntry,
  type SkillBundleArtifact
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

export function loadBundledSkillCatalog(
  options?: LoadCatalogOptions
): Promise<SkillCatalogEntry[]> {
  return createSkillCatalogFromBundle(bundledSkillBundle(), {
    platform: options?.platform ?? 'darwin'
  })
}
