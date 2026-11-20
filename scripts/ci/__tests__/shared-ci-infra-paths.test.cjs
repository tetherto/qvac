const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const workflowPath = resolve(__dirname, '../../../.github/workflows/on-pr-shared-ci-infra.yml')
const workflow = readFileSync(workflowPath, 'utf8')
const releaseProviderPaths = [
  '.github/workflows/_build.yml',
  '.github/scripts/lib/resolve-fabric-binary.mjs',
  '.github/scripts/test/released-provider-install.test.mjs',
  '.github/scripts/test/resolve-fabric-binary.test.mjs'
]

for (const path of releaseProviderPaths) {
  test(`shared CI runs release provider regression tests when ${path} changes`, () => {
    const paths = workflow.match(/^    paths:\r?\n((?:^      .*\r?\n)+)/m)
    assert.ok(paths, 'the pull request trigger must have a paths filter')
    assert.ok(paths[1].includes(`- "${path}"`), `missing trigger path: ${path}`)
    assert.match(
      workflow,
      /run: node --test \.github\/scripts\/test\/released-provider-install\.test\.mjs \.github\/scripts\/test\/resolve-fabric-binary\.test\.mjs/
    )
  })
}
