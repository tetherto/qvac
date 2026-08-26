#!/usr/bin/env node
// Builds the sibling in-monorepo @qvac/sdk so the
// `dependencies["@qvac/sdk"] = "file:../sdk"` symlink resolves a populated
// dist/. No-op outside the monorepo (downstream consumers don't have
// ../sdk).
//
// Pairs with scripts/check-publish-ready.cjs, which fails `npm publish`
// while either the file:-ref dep or this preinstall hook is still wired up
// in package.json.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SDK_DIR = path.resolve(__dirname, '..', '..', 'sdk')
const SDK_PKG = path.join(SDK_DIR, 'package.json')
const BUILT_MARKER = path.join(SDK_DIR, 'dist', 'commands', 'index.js')

function isMonorepoSibling() {
  try {
    const pkg = JSON.parse(fs.readFileSync(SDK_PKG, 'utf8'))
    return pkg.name === '@qvac/sdk'
  } catch {
    return false
  }
}

function alreadyBuilt() {
  // If the marker file is newer than every tracked source file under
  // packages/sdk, skip the rebuild. Walk everything except node_modules /
  // dist to keep the check cheap.
  let markerMtime
  try {
    markerMtime = fs.statSync(BUILT_MARKER).mtimeMs
  } catch {
    return false
  }

  const skip = new Set(['node_modules', 'dist', '.cache'])
  const stack = [SDK_DIR]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      let mtime
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch {
        continue
      }
      if (mtime > markerMtime) return false
    }
  }
  return true
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: SDK_DIR, stdio: 'inherit', ...opts })
  if (result.error) {
    console.error(`[@qvac/cli preinstall] failed to spawn '${cmd}': ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[@qvac/cli preinstall] ${cmd} ${args.join(' ')} failed in ${SDK_DIR}`)
    process.exit(result.status ?? 1)
  }
}

if (!isMonorepoSibling()) {
  process.exit(0)
}

const skipCompile = alreadyBuilt()
run('bun', ['run', './scripts/link-workspace-inference.ts'])

if (skipCompile) {
  console.log('[@qvac/cli preinstall] @qvac/sdk dist is up to date, skipping rebuild')
  process.exit(0)
}

console.log('[@qvac/cli preinstall] Building local @qvac/sdk at', SDK_DIR)

try {
  fs.rmSync(path.join(SDK_DIR, 'dist'), { recursive: true, force: true })
} catch {}
run(path.join(SDK_DIR, 'node_modules', '.bin', 'tsc'), ['--project', 'tsconfig.json'])
run(path.join(SDK_DIR, 'node_modules', '.bin', 'tsc-alias'), ['-p', 'tsconfig.alias.json'])
