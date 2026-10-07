#!/usr/bin/env node
/**
 * Every model a declarative body loads is declared in its test's metadata. The pre-download and the
 * per-test preload read the metadata alone, so a body loading anything else fetches it mid-test,
 * against a timeout sized for the test.
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const catalogPath = resolve(here, '../dist/tests/test-definitions.js')
if (!existsSync(catalogPath)) {
  console.error('❌ dist/tests/test-definitions.js is missing — run `npm run build` first.')
  process.exit(1)
}
const { tests } = await import(pathToFileURL(catalogPath).href)

/** The keys `metadata` declares, read the way `collectTestDeps` and `modelSetup` read them. */
function declared(metadata = {}) {
  const keys = new Set()
  const add = (entry) => {
    if (typeof entry !== 'string' || entry === 'none') return
    for (const key of entry.split('+')) if (key) keys.add(key)
  }
  add(metadata.dependency)
  for (const entry of Array.isArray(metadata.dependencies) ? metadata.dependencies : []) add(entry)
  return keys
}

/** Literal `useModel.deps` keys anywhere in a body; `$references` resolve at run time. */
function loaded(node, keys = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) loaded(item, keys)
  } else if (node && typeof node === 'object') {
    for (const dep of node.useModel?.deps ?? []) {
      if (typeof dep === 'string' && !dep.startsWith('$')) keys.add(dep)
    }
    for (const value of Object.values(node)) loaded(value, keys)
  }
  return keys
}

const problems = []
for (const test of tests) {
  if (!test.steps) continue
  const missing = [...loaded([test.steps, test.finally ?? []])].filter(
    (key) => !declared(test.metadata).has(key)
  )
  if (missing.length > 0) problems.push(`${test.testId}: loads ${missing.join(', ')}`)
}

if (problems.length > 0) {
  console.error(`❌ ${problems.length} body/metadata dependency mismatch(es):`)
  for (const problem of problems) console.error(`   ${problem}`)
  process.exit(1)
}
console.log('✅ Every model a body loads is declared in its metadata')
