#!/usr/bin/env node
// Workspace to host only: the host path has no package component, so the reverse would mix packages.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

export function hostDirFrom(sources) {
  const entry = (sources || '').split(';').find((s) => s.startsWith('files,'))
  return entry ? entry.split(',')[1] : ''
}

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []
  )
}

// Temp-then-rename: other runner instances read the host dir concurrently.
export function syncInto(from, to) {
  let copied = 0
  for (const f of files(from)) {
    const out = join(to, relative(from, f))
    if (existsSync(out)) continue
    try {
      mkdirSync(dirname(out), { recursive: true, mode: 0o777 })
      const tmp = `${out}.tmp.${process.pid}`
      copyFileSync(f, tmp)
      chmodSync(tmp, 0o666)
      renameSync(tmp, out)
      copied++
    } catch {
      rmSync(`${out}.tmp.${process.pid}`, { force: true })
    }
  }
  return copied
}

function main(env) {
  const host = hostDirFrom(env.VCPKG_BINARY_SOURCES)
  if (!host || !existsSync(host) || host === env.VCPKG_CACHE_DIR)
    return console.log('sync: no separate host dir')
  console.log(`sync: copied ${syncInto(env.VCPKG_CACHE_DIR, host)} archives into ${host}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
