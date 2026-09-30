'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { findMobileBundleImportProblems } = require('../check-mobile-bundle-imports')

const PACKAGE_ROOT = path.resolve(__dirname, '../..')
const FIXTURE_PREFIX = 'tts-ggml-mobile-bundle-'

function writeFixtureFile(root, relativePath, content) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function writeFixtureFiles(root, files) {
  Object.entries(files).forEach(([relativePath, content]) =>
    writeFixtureFile(root, relativePath, content)
  )
}

function problemsForFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeFixtureFiles(root, files)
  return findMobileBundleImportProblems(root)
}

test('every module the tts-ggml mobile bundle imports resolves', () => {
  assert.deepEqual(findMobileBundleImportProblems(PACKAGE_ROOT), [])
})

test('a test/mobile file that imports outside test/mobile is rejected', (t) => {
  const problems = problemsForFixture(t, {
    'test/integration/pocket.integration.test.js': '',
    'test/mobile/pocket-worklet.cjs': "require('../integration/pocket.integration.test.js')\n"
  })

  assert.equal(problems.length, 1)
  assert.match(
    problems[0],
    /test\/mobile\/pocket-worklet\.cjs imports '\.\.\/integration\/pocket\.integration\.test\.js'/
  )
})

test('inlined sibling requires must name an existing test/mobile file', (t) => {
  const problems = problemsForFixture(t, {
    'test/mobile/helpers.cjs': '',
    'test/mobile/tests.cjs': [
      "require('./helpers.cjs')",
      "require('./helpers')",
      "require('./absent.cjs')",
      "require('./helpers.js')"
    ].join('\n')
  })

  assert.equal(problems.length, 2)
  assert.match(problems[0], /imports '\.\/absent\.cjs'/)
  assert.match(problems[1], /imports '\.\/helpers\.js'/)
})

test('package specifiers are left to the mobile test framework install', (t) => {
  const problems = problemsForFixture(t, {
    'test/mobile/tests.cjs': "require('bare-path')\nrequire('@qvac/tts-ggml')\n"
  })

  assert.deepEqual(problems, [])
})

test('integration.auto.cjs may only run integration modules that exist', (t) => {
  const problems = problemsForFixture(t, {
    'test/integration/present.test.js': '',
    'test/mobile/integration.auto.cjs': [
      "runIntegrationModule('../integration/present.test.js', options)",
      "runIntegrationModule('../integration/removed.test.js', options)"
    ].join('\n')
  })

  assert.equal(problems.length, 1)
  assert.match(problems[0], /runs '\.\.\/integration\/removed\.test\.js', which does not exist/)
})
