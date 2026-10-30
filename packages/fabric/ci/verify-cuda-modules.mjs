#!/usr/bin/env node
// The module checks main's prebuild ran after fabric's CUDA builds: exactly one ggml CUDA module on linux-x64, and
// exactly one CUDA and one Vulkan module on win32-x64, anywhere under prebuilds/<host>.
//
//   node ci/verify-cuda-modules.mjs linux-x64|win32-x64

import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))

export const EXPECTED = {
  'linux-x64': { 'CUDA module': 'ggml-cuda.so' },
  'win32-x64': { 'CUDA module': 'ggml-cuda.dll', 'Vulkan module': 'ggml-vulkan.dll' }
}

export function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]
  )
}

// Each label's matches, as main's `**/*<suffix>` globs counted them.
export function count(prebuilds, host) {
  const all = files(join(prebuilds, host))
  return Object.entries(EXPECTED[host]).map(([label, suffix]) => ({
    label,
    found: all.filter((f) => f.endsWith(suffix))
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.argv[2]
  if (!EXPECTED[host]) throw new Error(`host must be ${Object.keys(EXPECTED).join(' or ')}`)
  const prebuilds = join(PKG, 'prebuilds')
  for (const { label, found } of count(prebuilds, host)) {
    if (found.length !== 1) throw new Error(`expected one ${host} ${label}, found ${found.length}`)
    console.log(`${label}: ${relative(prebuilds, found[0])}`)
  }
}
