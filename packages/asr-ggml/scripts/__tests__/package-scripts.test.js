'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const scripts = packageJson.scripts
const integrationRoot = path.join(packageRoot, 'test', 'integration')
const specializedSuites = [
  'test:integration:accuracy',
  'test:integration:long',
  'test:integration:cold-start',
  'test:integration:gpu',
  'test:integration:parakeet:gpu',
  'test:stand-alone:gpu',
  'test:cpp'
]
const specializedFilePatterns = [
  /accuracy-multilang/,
  /cold-start-timing/,
  /gpu(?:-smoke)?\.test/,
  /longES/,
  /mobile-perf/
]

function getInvokedScripts(command) {
  return [...command.matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1])
}

function isSpecializedIntegrationTest(fileName) {
  return specializedFilePatterns.some((pattern) => pattern.test(fileName))
}

function getStandardIntegrationCommand() {
  return `${scripts['test:integration:whisper']} ${scripts['test:integration:parakeet:generate']}`
}

function assertStandardIntegrationFileIsReferenced(fileName) {
  if (isSpecializedIntegrationTest(fileName)) return
  assert.match(getStandardIntegrationCommand(), new RegExp(`test/integration/${fileName}`))
}

test('standard integration runs both engine suites', () => {
  assert.deepEqual(getInvokedScripts(scripts['test:integration']), [
    'test:integration:whisper',
    'test:integration:parakeet'
  ])
})

test('standard aggregate excludes specialized suites', () => {
  const invokedScripts = getInvokedScripts(scripts['test:all'])
  specializedSuites.forEach((suite) => assert.equal(invokedScripts.includes(suite), false, suite))
  assert.equal(new Set(invokedScripts).size, invokedScripts.length)
})

test('CI unit suite includes the packed-package contract', () => {
  assert.match(scripts['test:unit'], /npm run test:package/)
})

test('every standard integration test is included by an engine suite', () => {
  fs.readdirSync(integrationRoot)
    .filter((fileName) => fileName.endsWith('.test.js'))
    .forEach(assertStandardIntegrationFileIsReferenced)
})

test('GPU commands preserve separate CI handling', () => {
  assert.equal(scripts['test:integration:gpu'], 'npm run test:integration:whisper:gpu')
  assert.match(scripts['test:integration:parakeet:gpu'], /parakeet-gpu-smoke\.test\.js/)
  assert.match(scripts['test:integration:parakeet:gpu'], /parakeet-run-tests\.sh/)
})

test('correct live-stream command retains the temporary typo alias', () => {
  assert.match(
    scripts['test:integration:live-stream-simulation'],
    /live-stream-simulation\.test\.js/
  )
  assert.equal(
    scripts['test:integration:live-stream-simultion'],
    'npm run test:integration:live-stream-simulation'
  )
})
