import assert from 'node:assert/strict'
import test from 'node:test'

import * as packageRoot from '../src/index.js'
import {
  catalogEntriesWithUnknownConstant,
  findCatalogEntry,
  isCatalogId,
  qvacCatalog,
  resolveModelConstant
} from '../src/models/catalog.js'

test('every catalog entry resolves to a real SDK constant (no drift)', () => {
  const orphans = catalogEntriesWithUnknownConstant()
  assert.deepEqual(
    orphans,
    [],
    `catalog ids point at constants missing from allModels: ${orphans.map((e) => `${e.id} -> ${e.constant}`).join(', ')}`
  )
})

test('catalog ids are unique and stay lowercase/models.dev-shaped', () => {
  const ids = qvacCatalog.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate catalog id')
  for (const id of ids) assert.match(id, /^[a-z0-9.\-]+$/, `id "${id}" is not models.dev-shaped`)
})

test('resolveModelConstant maps a public id to its constant', () => {
  assert.equal(resolveModelConstant('qwen3.5-9b'), 'QWEN3_5_9B_MULTIMODAL_Q4_K_M')
})

test('resolveModelConstant passes a bare constant through unchanged', () => {
  assert.equal(resolveModelConstant('QWEN3_5_9B_MULTIMODAL_Q4_K_M'), 'QWEN3_5_9B_MULTIMODAL_Q4_K_M')
  // An unknown / non-catalog constant is left untouched (back-compat).
  assert.equal(resolveModelConstant('QWEN3_600M_INST_Q4'), 'QWEN3_600M_INST_Q4')
})

test('findCatalogEntry resolves by id or by constant to the same entry', () => {
  const byId = findCatalogEntry('qwen3.5-9b')
  const byConstant = findCatalogEntry('QWEN3_5_9B_MULTIMODAL_Q4_K_M')
  assert.ok(byId)
  assert.equal(byId, byConstant)
  assert.equal(byId?.name, 'Qwen3.5 9B')
  assert.equal(findCatalogEntry('nope'), undefined)
})

test('isCatalogId is true only for public ids, not constants', () => {
  assert.equal(isCatalogId('qwen3.5-9b'), true)
  assert.equal(isCatalogId('QWEN3_5_9B_MULTIMODAL_Q4_K_M'), false)
  assert.equal(isCatalogId('nope'), false)
})

test('the catalog is reachable from the public `models` namespace', () => {
  assert.ok('qvacCatalog' in packageRoot.models, 'models namespace should export qvacCatalog')
  assert.ok('resolveModelConstant' in packageRoot.models)
})
