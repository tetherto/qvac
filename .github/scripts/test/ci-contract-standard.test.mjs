// Every package tagged ci:addons follows the package standard (docs/ci/workflow-standard.md), checked with the
// same rules select-projects.mjs applies when it builds job rows, so a mistake fails here rather than mid-run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TAG,
  TARGETS,
  CONFIG_NAME,
  configurations,
  checkMetadata,
  parseRunnerLabels,
  gateKeys
} from '../select-projects.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')

const contract = readdirSync(join(root, 'packages'))
  .map((dir) => join('packages', dir, 'project.json'))
  .filter((path) => existsSync(join(root, path)))
  .map((path) => ({ path, ...JSON.parse(read(path)) }))
  .filter((project) => project.tags?.includes(TAG))

// Targets whose jobs restore the build job's prebuild-<slug>-<platform>-<arch> artifact.
const RESTORE_BUILD = ['cpp:build', 'cpp:tests', 'test:integration', 'test:backend', 'benchmark']
// Targets that set up the host; an argument meant for the target after them must never reach their commands.
const HOST_TARGETS = ['ci:setup', 'ci:system']

test('at least one package is on the contract', () => {
  assert.ok(contract.length > 0, `no packages/*/project.json carries the ${TAG} tag`)
})

for (const project of contract) {
  const targets = Object.keys(project.targets ?? {})

  test(`${project.name}: declares only standard targets`, () => {
    const extra = targets.filter((t) => !TARGETS.includes(t))
    assert.deepEqual(
      extra,
      [],
      `${project.path}: ${extra.join(', ')} is not a standard target; use a standard name or add it to TARGETS in .github/scripts/select-projects.mjs`
    )
  })

  test(`${project.name}: configurations and metadata follow the standard`, () => {
    const runners = parseRunnerLabels(read('.github/workflows/reusable-runner-names.yml'))
    for (const target of targets) {
      checkMetadata(project, target)
      if (target === 'ci:system') {
        // Its configurations only mirror the build's names so `-c <configuration>` reaches it; they never become jobs.
        for (const [config, cfg] of Object.entries(project.targets[target].configurations ?? {})) {
          assert.match(
            config,
            CONFIG_NAME,
            `${project.path} ${target} ${config}: configuration name`
          )
          assert.deepEqual(
            Object.keys(cfg),
            ['commands'],
            `${project.path} ${target} ${config}: only commands`
          )
        }
        continue
      }
      for (const cfg of configurations(project, target))
        assert.ok(
          runners[cfg.runnerKey],
          `${project.path} ${target} ${cfg.config}: runner key ${cfg.runnerKey} is not in reusable-runner-names.yml`
        )
    }
  })

  test(`${project.name}: has a Merge Guard key`, () => {
    const dir = project.path.split('/')[1]
    assert.ok(
      gateKeys(read('.github/workflows/pr-gate-merge.yml'))[dir],
      `${project.path}: add a pr-gate-merge.yml filter whose first path is "packages/${dir}/**"`
    )
  })

  test(`${project.name}: host setup targets take no forwarded arguments`, () => {
    for (const target of HOST_TARGETS.filter((t) => targets.includes(t)))
      assert.equal(
        project.targets[target].options?.forwardAllArgs,
        false,
        `${project.path} ${target}: set options.forwardAllArgs to false`
      )
  })

  test(`${project.name}: every configuration that restores the build has a build configuration to restore`, () => {
    // A package without a build target restores no prebuilds; its tests run against the installed workspace.
    if (!project.targets.build) return
    const built = new Set(Object.keys(project.targets.build.configurations ?? {}))
    for (const target of RESTORE_BUILD.filter((t) => targets.includes(t)))
      for (const cfg of configurations(project, target))
        assert.ok(
          built.has(`${cfg.platform}-${cfg.arch}`),
          `${project.path} ${target} ${cfg.config}: no build configuration ${cfg.platform}-${cfg.arch} produces its prebuild`
        )
  })
}

test('the groups request only standard targets', () => {
  const workflows = readdirSync(join(root, '.github/workflows')).filter((f) => f.endsWith('.yml'))
  for (const file of workflows) {
    const source = read(join('.github/workflows', file))
    if (!source.includes('uses: ./.github/workflows/_select-projects.yml')) continue
    for (const [, list] of source.matchAll(/^\s+targets:\s*(.+)$/gm)) {
      const extra = list
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t && !TARGETS.includes(t))
      assert.deepEqual(extra, [], `${file}: requests ${extra.join(', ')}`)
    }
  }
})
