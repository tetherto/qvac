import type { LaunchOptions } from './lib/types.js'
// The Pear entry: the same launcher as qvac-bare, with Core and the harness bundled as assets.
import process from 'bare-process'
import { launch } from './cli/launch.js'

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

await launch(Bare.argv.slice(1), {
  launcher: null,
  node: 'node',
  async runApp(options: LaunchOptions, env) {
    Object.assign(process.env, env)
    const { main } = await import('./product/main.js')
    await main({ ...options, standalone: true, entries })
  }
})
