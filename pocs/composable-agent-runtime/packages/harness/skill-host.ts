/**
 * Authoring kit for the host half of a skill, plus the pieces an application
 * needs to build and ship its own skill bundle. Kept out of the root entry so a
 * plain client process never pulls worker plumbing into its graph.
 */
export { composeSkillHost } from './lib/skills/compose.ts'
export type {
  ComposeSkillHostOptions,
  ComposedSkillHost
} from './lib/skills/compose.ts'
export type {
  SkillHostContext,
  SkillHostContribution,
  SkillHostProvider,
  SkillPermissionRequest,
  SkillSandboxContribution
} from './lib/skills/host.ts'
export {
  createHarnessChildEntry,
  type CreateHarnessChildEntryOptions
} from './lib/skills/host-entry.ts'
export {
  createSkillCatalogFromBundle,
  resolveSkillCatalog,
  type SkillBundleArtifact,
  type SkillCatalogEntry,
  type SkillCatalogSource
} from './lib/skills/catalog.ts'
export { hashBundledSkills, verifyBundledSkillsHash } from './lib/skills/bundled-hash.ts'
export { composeSkillPrompt } from './lib/skills/prompt.ts'
export { parseToolGrant, type ToolGrant } from './lib/skills/tool-grants.ts'
export type {
  SdkImageGenerationInput,
  SdkImageGenerationResult,
  SdkImageProgress,
  SdkRuntimePort
} from './lib/sdk-runtime-port.ts'
export type { HarnessHostConfig } from './lib/runtime/host-config.ts'
export type { HarnessJsonValue } from './lib/types.ts'
