import test from 'node:test'
import assert from 'node:assert/strict'
import { sdkTree, sdkOptions } from '../../dist/cli/commands/sdk/tree.js'
import { parseArgs } from '../../dist/cli/index.js'

const parse = (words) => sdkTree().parse(words, { sync: true, run: false })

test('peer serve and SDK HTTP serve have separate routes', () => {
  assert.equal(parseArgs(['serve'], { env: {} }).where, 'core')
  const sdk = parseArgs(['sdk', 'serve', '--openai'], { env: {} })
  assert.equal(sdk.where, 'launcher')
  assert.deepEqual(sdk.words, ['serve', '--openai'])
})

test('SDK repeatable, short, and negative flags preserve handler options', () => {
  const options = sdkOptions(
    parse(['serve', '-p', '9876', '--model', 'a', '--model', 'b', '--no-default', '--no-lazy-load'])
  )
  assert.equal(options.port, '9876')
  assert.deepEqual(options.model, ['a', 'b'])
  assert.equal(options.default, false)
  assert.equal(options.lazyLoad, false)
})

test('SDK deprecated aliases inherit explicit parent flags', () => {
  const options = sdkOptions(parse(['serve', '--port', '9876', '--model', 'a', 'openai']))
  assert.equal(options.port, '9876')
  assert.deepEqual(options.model, ['a'])
})

test('SDK required options fail before dispatch and unknown flags are rejected', () => {
  assert.throws(() => sdkOptions(parse(['verify', 'bundle'])), /addons-source/)
  assert.throws(() => parse(['serve', '--not-a-flag']), /not-a-flag/)
})

test('managed integrations keep their explicit legacy HTTP serve launch', () => {
  for (const words of [
    ['serve', '--openai', '--no-default', '--ready-fd', '3'],
    ['serve', 'openai']
  ]) {
    const route = parseArgs(words, { env: {} })
    assert.equal(route.command, 'sdk')
    assert.equal(route.where, 'launcher')
    assert.deepEqual(route.words, words)
  }
})
