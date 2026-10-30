#!/usr/bin/env node
// Runs a command with the MSVC environment setup-cuda wrote to QVAC_MSVC_ENV_FILE (msvc-scope: file), so only that
// command compiles with the CUDA-compatible toolset. Without the file the command runs unchanged.

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function withMsvcEnv(base, file) {
  const env = { ...base }
  if (!file || !existsSync(file)) return env
  for (const raw of readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const at = raw.indexOf('=')
    if (at < 1) continue
    const name = raw.slice(0, at).replace(/^\uFEFF/, '')
    // Windows names are case-insensitive: drop Path before setting PATH.
    for (const key of Object.keys(env))
      if (key.toUpperCase() === name.toUpperCase()) delete env[key]
    env[name] = raw.slice(at + 1)
  }
  return env
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('usage: msvc-env.mjs <command> [args...]')
  const env = withMsvcEnv(process.env, process.env.QVAC_MSVC_ENV_FILE)
  const r = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
  if (r.error) throw r.error
  process.exit(r.status ?? 1)
}
