#!/usr/bin/env node
// prebuilds/<platform>-<arch>/ is the only layout the runtime and the npm tarball accept.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function place({ staging, dest, platform, arch, extraDirs = [] }) {
  mkdirSync(dest, { recursive: true })
  if (platform && arch) {
    const src = join(staging, `${platform}-${arch}`)
    if (!existsSync(src)) throw new Error(`No '${platform}-${arch}/' in the prebuilds bundle`)
    cpSync(src, join(dest, `${platform}-${arch}`), { recursive: true })
  } else {
    if (!existsSync(staging) || !readdirSync(staging).length)
      throw new Error('Prebuilds bundle is missing or empty')
    cpSync(staging, dest, { recursive: true })
  }
  const bad = readdirSync(dest).filter(
    (d) => statSync(join(dest, d)).isDirectory() && !d.includes('-') && !extraDirs.includes(d)
  )
  if (bad.length)
    throw new Error(`${bad.join(', ')} under prebuilds/ is not a <platform>-<arch> directory`)
  return readdirSync(dest)
}

function main(env) {
  const placed = place({
    staging: env.STAGING,
    dest: join(env.WORKDIR, 'prebuilds'),
    platform: env.PLATFORM,
    arch: env.ARCH,
    extraDirs: (env.EXTRA_DIRS || '').split(' ').filter(Boolean)
  })
  console.log(placed.join('\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
