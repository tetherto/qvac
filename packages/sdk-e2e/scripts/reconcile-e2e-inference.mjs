#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCKFILE = path.join(E2E_DIR, 'package-lock.json')
const NODE_MODULES = path.join(E2E_DIR, 'node_modules')
const DEPENDENCY = '@qvac/inference'

function isLocallyPinned() {
  if (!fs.existsSync(LOCKFILE)) return false
  const lock = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'))
  return Object.entries(lock.packages ?? {}).some(([key, entry]) => {
    if (key !== `node_modules/${DEPENDENCY}` && !key.endsWith(`/node_modules/${DEPENDENCY}`)) {
      return false
    }
    return typeof entry.resolved !== 'string' || entry.resolved.startsWith('file:')
  })
}

// Deleting just node_modules/@qvac/inference, `npm update`, or `npm install
// <pkg>@<spec> --no-save` all leave npm serving the stale resolution. Only
// wiping both the lockfile and node_modules forces a real re-resolve.
export function resetInstallState() {
  fs.rmSync(LOCKFILE, { force: true })
  fs.rmSync(NODE_MODULES, { recursive: true, force: true })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes('--force')
  if (force || isLocallyPinned()) {
    console.log(
      `\n♻️  Resetting e2e's install state so ${DEPENDENCY} re-resolves ${force ? '' : '(was pinned to a local build) '}...`
    )
    resetInstallState()
  } else {
    console.log(`\n✓ e2e is not pinned to a local ${DEPENDENCY} build; nothing to reconcile.`)
  }
}
