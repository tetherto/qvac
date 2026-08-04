import { createHarnessChildEntry } from './lib/skills/host-entry.ts'

/**
 * The default harness worker, with no skills. Applications that ship skills
 * author their own entry with @qvac/harness/skill-host, because the bundler
 * resolves providers from static imports and cannot discover them at runtime.
 */
export default createHarnessChildEntry({ skills: [] })
