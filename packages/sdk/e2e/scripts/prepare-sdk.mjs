#!/usr/bin/env node
// Builds packages/sdk for `install:build:sdk`.
//
// A plain `npm install` in packages/sdk resolves @qvac/inference to its
// published release and fails with ERESOLVE whenever the SDK on main already
// depends on addon versions that release was not built against, so the SDK is
// installed through its workspace link instead. That link rewrites
// packages/sdk/package.json; the manifest is restored afterwards because
// build-local-inference.mjs refuses to run over a leftover local spec, and
// node_modules keeps the link either way.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SDK_MANIFEST = path.join(SDK_DIR, 'package.json')

function childEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_'))
  )
}

function npm(args) {
  execFileSync('npm', args, {
    cwd: SDK_DIR,
    env: childEnv(),
    shell: process.platform === 'win32',
    stdio: 'inherit'
  })
}

const originalManifest = fs.readFileSync(SDK_MANIFEST, 'utf8')
try {
  npm(['run', 'sdk-source:workspace'])
  npm(['run', 'build'])
} finally {
  fs.writeFileSync(SDK_MANIFEST, originalManifest)
}
