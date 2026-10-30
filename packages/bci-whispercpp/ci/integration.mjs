#!/usr/bin/env node
// bci's test:integration, as main's desktop test workflow ran it: the neural-signal fixtures from the private release
// (GITHUB_TOKEN), the Vulkan loader next to the addon on win32, then the suite. The manifest supplies the models.
//
//   node ci/integration.mjs [--script test:integration:smoke] [--set NAME=value]...

import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))

export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      script: { type: 'string', default: 'test:integration' },
      set: { type: 'string', multiple: true, default: [] }
    },
    strict: true
  })
  const env = {}
  for (const pair of values.set) {
    const at = pair.indexOf('=')
    if (at < 1) throw new Error(`--set takes NAME=value, got '${pair}'`)
    env[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return { script: values.script, env }
}

export function fetchFixtures(env = process.env) {
  run('node', ['scripts/download-models.js', '--fixtures'], env)
}

// The first vulkan-1.dll the runner has, next to the first .bare under prebuilds/win32-x64, as main copied it.
export function copyVulkanLoader(env = process.env) {
  const candidates = [
    join(env.WINDIR ?? 'C:\\Windows', 'System32', 'vulkan-1.dll'),
    join(env.VULKAN_SDK ?? 'C:\\VulkanSDK', 'Bin', 'vulkan-1.dll')
  ]
  const loader = candidates.find((f) => existsSync(f))
  const root = join(PKG, 'prebuilds/win32-x64')
  const addon = existsSync(root)
    ? readdirSync(root, { recursive: true })
        .map(String)
        .find((f) => f.endsWith('.bare'))
    : null
  if (!loader || !addon) {
    console.log('vulkan-1.dll or addon dir not found; skipping copy')
    return
  }
  const dest = join(root, dirname(addon))
  copyFileSync(loader, join(dest, 'vulkan-1.dll'))
  console.log(`copied ${loader} -> ${dest}`)
}

export function run(cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, {
    cwd: PKG,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options(process.argv.slice(2))
  const env = { ...process.env, ...o.env }
  fetchFixtures(env)
  if (process.platform === 'win32') copyVulkanLoader(env)
  run('npm', ['run', o.script], env)
}
