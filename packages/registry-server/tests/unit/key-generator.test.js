'use strict'

const test = require('brittle')
const { generatePrimaryKey } = require('../../utils/key-generator')

test('generatePrimaryKey - generates valid hypercore key', async (t) => {
  t.plan(3)

  const key = generatePrimaryKey()

  t.ok(key, 'Should generate a key')
  t.is(typeof key, 'object', 'Key should be an object')
  t.is(key.length, 32, 'Key should be 32 bytes (hypercore key size)')
})

test('generatePrimaryKey - generates unique keys', async (t) => {
  t.plan(1)

  const key1 = generatePrimaryKey()
  const key2 = generatePrimaryKey()

  t.not(key1.toString('hex'), key2.toString('hex'), 'Should generate unique keys')
})

test('generatePrimaryKey - accepts seed parameter', async (t) => {
  t.plan(3)

  const seed = 'test-seed'
  const key1 = generatePrimaryKey(seed)
  const key2 = generatePrimaryKey(seed)
  const key3 = generatePrimaryKey('different-seed')

  t.is(key1.length, 32, 'Key with seed should be 32 bytes')
  t.is(key1.toString('hex'), key2.toString('hex'), 'Same seed produces same key (deterministic)')
  t.not(key1.toString('hex'), key3.toString('hex'), 'Different seeds produce different keys')
})
