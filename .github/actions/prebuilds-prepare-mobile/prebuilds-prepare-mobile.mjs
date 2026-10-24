#!/usr/bin/env node
// Checks a package's prebuilds/ and lays it out for the mobile build.

import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const COPIES = {
  'android-arm64': ['android-ia32', 'android-arm', 'android-x64'],
  'ios-arm64': ['ios-arm64-simulator', 'ios-x64-simulator']
}

const list = (dir) => (existsSync(dir) ? readdirSync(dir) : [])

// A split addon names each host's module after its platform package; every iOS host shares -ios.
export function foreignStem(files, addon, dir) {
  const expected = `qvac__${addon}`
  const suffix = dir.startsWith('ios-') ? 'ios' : dir
  let foreign = ''
  for (const f of files.filter((n) => n.startsWith('qvac__'))) {
    const stem = f.split('.')[0]
    if (stem === expected || stem === `${expected}-${suffix}`) return ''
    foreign = stem
  }
  return foreign
}

export function prepare({ workdir, expectedDirs = [], source = '' }) {
  const dir = join(workdir, 'prebuilds')
  if (!list(dir).length) throw new Error(`no prebuilds in ${dir}`)
  const missing = expectedDirs.filter((d) => !list(join(dir, d)).length)
  if (missing.length)
    throw new Error(
      `${source || dir} has no ${missing.join(' ')}; its prebuild leg for this platform did not finish`
    )
  for (const d of expectedDirs) {
    const foreign = foreignStem(list(join(dir, d)), basename(workdir), d)
    if (foreign)
      throw new Error(`${source || dir} contains ${foreign}, not a build of ${basename(workdir)}`)
  }
  // Only an ABI nobody built: the simulator legs are real builds, and a device binary in their place breaks bare-link.
  for (const [from, tos] of Object.entries(COPIES)) {
    if (!existsSync(join(dir, from))) continue
    for (const to of tos)
      if (!existsSync(join(dir, to))) cpSync(join(dir, from), join(dir, to), { recursive: true })
  }
  for (const d of list(dir))
    if (/^(darwin|win32|linux)-/.test(d)) rmSync(join(dir, d), { recursive: true, force: true })
  return list(dir)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const dirs = prepare({
    workdir: env.WORKDIR,
    expectedDirs: (env.EXPECTED_DIRS || '').split(/\s+/).filter(Boolean),
    source: env.SOURCE
  })
  console.log(`Mobile prebuilds: ${dirs.join(' ')}`)
}
