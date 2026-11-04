#!/usr/bin/env node
/**
 * Download what a model-cache plan needs and the cache restore did not provide: one
 * `qvac-test run:bootstrap:<consumer>` per leg in the plan, each narrowed to that leg's deps and
 * resolving the resource table under the leg's platform label. Models already in the SDK cache
 * directory are verified and skipped by the SDK itself, so a leg whose models were all restored
 * costs only the checksum pass.
 *
 *   node scripts/model-cache-bootstrap.mjs --plan plan.json
 *
 * The Snap leg bootstraps inside the installed Snap instead (test-snap-sdk.yml), with the same
 * QVAC_E2E_BOOTSTRAP_DEPS this script sets.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { values } = parseArgs({ options: { plan: { type: 'string' } } })
if (!values.plan) throw new Error('--plan is required')

const plan = JSON.parse(readFileSync(resolve(values.plan), 'utf8'))

const failed = []
for (const leg of plan.legs) {
  if (leg.deps.length === 0) {
    console.log(`⏭️  ${leg.family} (${leg.platform}): no model deps, nothing to bootstrap`)
    continue
  }
  console.log(`🔧 ${leg.family} (${leg.platform}): bootstrapping ${leg.deps.length} dep(s)`)
  const result = spawnSync('npx', ['qvac-test', `run:bootstrap:${leg.consumer}`, '--config=.'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      // The consumer entry applies the resource table under this label as it is imported.
      QVAC_TEST_PLATFORM: leg.resourcePlatform,
      QVAC_E2E_BOOTSTRAP_DEPS: JSON.stringify(leg.deps)
    }
  })
  // Keep going: the next leg's models, and the save after this step, are worth having even
  // when one leg's download failed.
  if (result.status !== 0) failed.push(`${leg.family} (exit ${result.status ?? result.signal})`)
}
if (failed.length > 0) {
  console.error(`❌ Bootstrap failed for ${failed.join(', ')}`)
  process.exit(1)
}
