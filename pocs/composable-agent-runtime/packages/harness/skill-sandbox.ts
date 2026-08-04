/**
 * Authoring kit for the in-sandbox half of a skill. Kept out of the root entry
 * so a plain client process never pulls the sandbox transport into its graph.
 */
export {
  createSkillSandboxExecutor,
  type SkillSandboxContext,
  type SkillSandboxProvider
} from './lib/skills/sandbox.ts'
export {
  createToolSandboxChildEntry,
  type CreateToolSandboxChildEntryOptions
} from './lib/skills/sandbox-entry.ts'
export type {
  ToolSandboxExecutionRequest,
  ToolSandboxExecutor
} from './lib/tool-sandbox/wire.ts'
export type { HarnessJsonValue } from './lib/types.ts'
