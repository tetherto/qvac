import type { Agent } from '../types.js'
import type { Capabilities } from '@qvac/core/client'
// fs is passed in (bare-fs or node:fs) so core-host and the tests share one module.
const parent = (file: string) => String(file).replace(/[\\/][^\\/]*$/, '')

// The harness reads user skills from the folder beside the SDK config (overlay-dir.ts).
export const skillsOverlayDir = (sdkConfigPath: string) => `${parent(sdkConfigPath)}/skills`

// Copied on every boot, so the skills a CLI version ships replace the ones the last version left.
export function installSkills(
  fs: typeof import('bare-fs'),
  { from, sdkConfigPath }: { from: string; sdkConfigPath: string }
) {
  fs.cpSync(from, skillsOverlayDir(sdkConfigPath), { recursive: true })

  return (fs.readdirSync(from, { withFileTypes: true }) as import('bare-fs').Dirent<string>[])
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

// Core offers an agent only the skills it enabled; installedSkills keeps a skill the user turned off.
export async function enableSkills(
  engine: Capabilities,
  { meshId, agent, names }: { meshId: string; agent: Agent; names: string[] }
) {
  const installed = agent.installedSkills || []
  const fresh = names.filter((name) => !installed.includes(name))
  if (!fresh.length) {
    return
  }

  const enabledSkills = [...(agent.enabledSkills || []), ...fresh]
  await engine.updateAgent({ agentId: agent.id, meshId, config: { enabledSkills } })
}
