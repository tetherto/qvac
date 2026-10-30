#!/usr/bin/env node
// Runs verify-prebuild-symbols' checker; it moves here when that action is deleted.

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERIFIER = fileURLToPath(
  new URL('../verify-prebuild-symbols/verify-prebuild-symbols.mjs', import.meta.url)
)

// The provider's platform packages (<name>-<host>), wherever npm placed them.
export function providerDirs(workdir, provider) {
  const meta = join(workdir, 'node_modules', provider)
  if (!provider || !existsSync(meta)) return []
  const real = realpathSync(meta)
  const name = basename(provider)
  const roots = [
    dirname(real),
    join(real, 'node_modules', dirname(provider)),
    join(workdir, 'node_modules', dirname(provider))
  ]
  const found = roots.flatMap((root) =>
    existsSync(root)
      ? readdirSync(root)
          .filter((d) => d.startsWith(`${name}-`))
          .map((d) => join(root, d, 'prebuilds'))
          .filter(existsSync)
      : []
  )
  return [...new Set(found.map((d) => realpathSync(d)))]
}

function main(env) {
  if (env.PLATFORM === 'win32')
    return console.log('Symbol check skipped on win32: PE is not analyzed')
  const args = ['--dir', 'prebuilds', '--platform', env.PLATFORM]
  if (env.ENFORCE_EXPORTS === 'true') args.push('--enforce-exports')
  for (const d of providerDirs('.', env.PROVIDER)) args.push('--provider-dir', d)
  const childEnv = { ...process.env }
  if (env.PLATFORM === 'android') {
    const tc =
      env.ANDROID_TOOLCHAIN_ROOT ||
      join(env.ANDROID_NDK_HOME || '', 'toolchains/llvm/prebuilt/linux-x86_64')
    Object.assign(childEnv, {
      READELF: join(tc, 'bin/llvm-readelf'),
      NM: join(tc, 'bin/llvm-nm')
    })
  }
  execFileSync('node', [VERIFIER, ...args], {
    stdio: 'inherit',
    env: childEnv
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
