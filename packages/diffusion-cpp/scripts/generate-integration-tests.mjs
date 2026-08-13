import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const scriptPath = fileURLToPath(import.meta.url)
const packageDir = path.resolve(path.dirname(scriptPath), '..')
const integrationDir = path.join(packageDir, 'test', 'integration')
const brittleCli = require.resolve('brittle/bin/node.js')

export function getFlux2SkipReason({
  env = process.env,
  platform = process.platform,
  arch = process.arch
} = {}) {
  if (env.SKIP_FLUX2 === 'true') {
    return 'SKIP_FLUX2=true'
  }

  if (
    env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    platform === 'darwin' &&
    arch === 'arm64'
  ) {
    return 'GitHub-hosted Darwin arm64 runner'
  }

  return null
}

export function selectIntegrationTests(testFiles, runtime = {}) {
  const reason = getFlux2SkipReason(runtime)
  const selected = []
  const skipped = []

  for (const testFile of testFiles) {
    if (reason && /flux2/i.test(path.basename(testFile))) {
      skipped.push(testFile)
    } else {
      selected.push(testFile)
    }
  }

  return { reason, selected, skipped }
}

export function generateIntegrationTests() {
  const testFiles = fs
    .readdirSync(integrationDir)
    .filter((file) => file.endsWith('.test.js'))
    .sort()
    .map((file) => path.posix.join('test', 'integration', file))
  const selection = selectIntegrationTests(testFiles)

  for (const testFile of selection.skipped) {
    console.log(`[integration-selector] Skipping ${testFile}: ${selection.reason}`)
  }

  const result = spawnSync(
    process.execPath,
    [brittleCli, '-r', 'test/integration/all.js', ...selection.selected],
    {
      cwd: packageDir,
      stdio: 'inherit',
      shell: false
    }
  )

  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status
}

if (path.resolve(process.argv[1] || '') === path.resolve(scriptPath)) {
  generateIntegrationTests()
}
