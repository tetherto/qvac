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

const modelFamilyPatterns = new Map([
  ['flux2', /(?:^|[-_])flux2(?:[-_.]|$)/i],
  ['ideogram', /(?:^|[-_])ideogram(?:[-_.]|$)/i]
])
const githubHostedDarwinArm64Exclusions = ['flux2', 'ideogram']

function parseExcludedModelFamilies(value = '') {
  const families = [
    ...new Set(
      value
        .split(',')
        .map((family) => family.trim().toLowerCase())
        .filter(Boolean)
    )
  ]
  const unknownFamilies = families.filter((family) => !modelFamilyPatterns.has(family))

  if (unknownFamilies.length > 0) {
    throw new Error(`Unknown diffusion model families: ${unknownFamilies.join(', ')}`)
  }

  return families
}

export function getModelFamilyExclusions({
  env = process.env,
  platform = process.platform,
  arch = process.arch
} = {}) {
  const families = new Set(parseExcludedModelFamilies(env.SKIP_DIFFUSION_MODELS))
  const reasons = []

  if (families.size > 0) {
    reasons.push(`SKIP_DIFFUSION_MODELS=${[...families].join(',')}`)
  }

  if (
    env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    platform === 'darwin' &&
    arch === 'arm64'
  ) {
    for (const family of githubHostedDarwinArm64Exclusions) families.add(family)
    reasons.push('GitHub-hosted Darwin arm64 runner')
  }

  return {
    families: [...families],
    reason: reasons.length > 0 ? reasons.join('; ') : null
  }
}

export function selectIntegrationTests(testFiles, runtime = {}) {
  const { families, reason } = getModelFamilyExclusions(runtime)
  const selected = []
  const skipped = []
  const skippedByFamily = []

  for (const testFile of testFiles) {
    const family = families.find((candidate) =>
      modelFamilyPatterns.get(candidate).test(path.basename(testFile))
    )

    if (family) {
      skipped.push(testFile)
      skippedByFamily.push({ family, testFile })
    } else {
      selected.push(testFile)
    }
  }

  return { families, reason, selected, skipped, skippedByFamily }
}

export function generateIntegrationTests() {
  const testFiles = fs
    .readdirSync(integrationDir)
    .filter((file) => file.endsWith('.test.js'))
    .sort()
    .map((file) => path.posix.join('test', 'integration', file))
  const selection = selectIntegrationTests(testFiles)

  if (selection.families.length > 0) {
    console.log(
      `[integration-selector] Excluded model families: ${selection.families.join(', ')} (${selection.reason})`
    )
  }

  for (const { family, testFile } of selection.skippedByFamily) {
    console.log(`[integration-selector] Excluded ${testFile} (model family: ${family})`)
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
