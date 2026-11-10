// The Pear entry: the same launcher as qvac-bare, with Core and the harness bundled as assets.
import type { LaunchOptions } from './lib/types.js'
import { launch } from './cli/launch.js'
import { packageVersion } from './cli/version.js'
import process from 'bare-process'
import os from 'bare-os'
import path from 'bare-path'
import { fileURLToPath } from 'bare-url'
import { find, parseArgs } from './cli/index.js'

// Child bundles resolve native addons and skills beside themselves on disk.
// Mark the entire staged tree as assets, not only the four entry files.
import.meta.asset('./runtime/')

const entries = {
  sidecar: import.meta.asset('./runtime/sidecar.bundle'),
  harness: import.meta.asset('./runtime/harness.bundle'),
  skill: import.meta.asset('./runtime/skills/weather/SKILL.md'),
  cliSkill: import.meta.asset('./runtime/cli-skills/qvac-plugins/SKILL.md'),
  release: import.meta.asset('./runtime/release.json')
}

// the staged package.json
const root = path.dirname(fileURLToPath(import.meta.asset('../package.json')))

await launch(Bare.argv.slice(1), {
  tree: { parseArgs, find },
  name: 'qvac',
  root,
  version: packageVersion(root),
  dataDir: path.join(os.homedir(), '.qvac', 'cli'),
  launcher: null,
  node: 'node',
  async runApp(options: LaunchOptions, env) {
    Object.assign(process.env, env)
    const { main } = await import('./product/main.js')
    await main({ ...options, standalone: true, entries })
  }
})
