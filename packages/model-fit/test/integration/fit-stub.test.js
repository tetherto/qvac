'use strict'

// The registry serves a fit stub in place of the artefact: a short GGUF with
// the hyperparameters and tensor infos but no tokenizer tables and no data
// section, tens of KB against gigabytes. A caller passing one must get the plan
// it would have got from the full file, through the same API and with the file
// at its real length — no padding out to the artefact size, which NTFS
// allocates for real.
//
// Two fabric behaviours make that work, and each has a case here. 10549.0.0
// skips the file-bounds check under no_alloc, which is what lets the data
// section be absent rather than padded. It does not skip the vocab load, so
// `tokenizer.ggml.model = none` and a surviving `{arch}.vocab_size` are what
// keep the load from failing on the dropped tokenizer.

const test = require('brittle')
const fs = require('bare-fs')
const process = require('bare-process')
const { fitParams, FIT_STATUS } = require('../../index.js')
const { ensureModelPath } = require('./utils')
const { fixtureDir, fixturePath, kvValue, readGguf, writeFitStub, writeSplit } = require('./gguf')

const SPLIT_COUNT = 2

// Two shapes of request, so the comparison is not a single accidental path:
// one the fitter is free to place, one pinned to the CPU.
const CONFIGS = [
  { name: 'fitter-placed', nCtx: 2048, nCtxMin: 512, marginMiB: 1024 },
  { name: 'CPU-pinned', nCtx: 2048, marginMiB: 1024, nGpuLayers: 0, splitMode: 0, mainGpu: -1 }
]

let fixtures = null

// Built once: the full split copies the artefact, and FIT_MODEL_PATH may point
// at a real multi-gigabyte model.
async function ensureFixtures() {
  if (fixtures) return fixtures

  const fullPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

  // The fixtures are written beside the downloaded model, and downloading is
  // what creates that directory. FIT_MODEL_PATH skips the download, so on a
  // fresh checkout the directory is not there — this file is the first to write
  // into it rather than only read from it.
  fs.mkdirSync(fixtureDir(), { recursive: true })

  fixtures = {
    fullPath,
    stubPath: writeFitStub(fullPath, fixturePath('fit-stub.gguf')),
    fullSplit: writeSplit(fullPath, fixturePath('split-full'), { splitCount: SPLIT_COUNT }),
    stubSplit: writeSplit(fullPath, fixturePath('split-stub'), {
      splitCount: SPLIT_COUNT,
      stub: true
    })
  }
  return fixtures
}

// `freeBytes` is the backend's live free-memory gauge, read afresh on every
// fit, so two fits of the same model disagree by whatever else the machine did
// in between. It is the one field on a result that does not describe the model,
// and comparing it makes these cases a memory-quiescence test. Everything else,
// the rest of the projection included, stays in the comparison.
function planOf(res) {
  if (!Array.isArray(res.projection)) return res
  return {
    ...res,
    projection: res.projection.map(({ freeBytes, ...row }) => row)
  }
}

function fitOk(t, modelPath, config) {
  const { name, ...request } = config
  const res = fitParams({ modelPath, ...request })
  t.not(res.status, FIT_STATUS.ERROR, `${name}: the fitter read the model`)
  return planOf(res)
}

test('the stub is the shape the registry serves', async function (t) {
  const { fullPath, stubPath } = await ensureFixtures()
  const full = readGguf(fullPath)
  const stub = readGguf(stubPath)

  t.is(fs.statSync(stubPath).size, stub.dataOffset, 'nothing follows the header')
  t.ok(fs.statSync(stubPath).size < fs.statSync(fullPath).size, 'the stub is shorter')

  t.is(stub.tensors.length, full.tensors.length, 'every tensor info survives')

  // The stub keeps the artefact's layout, so its offsets are the full file's.
  // That is what puts them past its own EOF: nothing follows the header, so any
  // non-zero offset is already beyond every byte the stub holds. Phrasing that
  // as arithmetic against the stub's own size would reduce to `offset >= 0`
  // given the equality above, and would hold for a stub with every offset 0.
  const offsets = (meta) => meta.tensors.map((tensor) => tensor.offset).sort((a, b) => a - b)
  t.alike(offsets(stub), offsets(full), 'the offsets are the artefact layout')

  const last = stub.tensors.reduce((a, b) => (a.offset > b.offset ? a : b))
  t.ok(last.offset > 0, 'the last tensor starts past the end of the stub')

  // The vocab load still runs, so these are the keys that cannot go.
  t.is(kvValue(stub, 'tokenizer.ggml.model'), 'none', 'the tokenizer is declared absent')
  const arch = kvValue(stub, 'general.architecture')
  t.is(typeof kvValue(stub, `${arch}.vocab_size`), 'number', 'the vocabulary size survives')

  const tokenizerKeys = stub.kvs.map((kv) => kv.key).filter((key) => key.startsWith('tokenizer.'))
  t.alike(
    tokenizerKeys.filter((key) => key !== 'tokenizer.ggml.token_type_count'),
    ['tokenizer.ggml.model'],
    'the tokenizer tables are gone'
  )
})

test('a fit stub projects the same plan as the full file', async function (t) {
  const { fullPath, stubPath } = await ensureFixtures()

  for (const config of CONFIGS) {
    t.alike(
      fitOk(t, stubPath, config),
      fitOk(t, fullPath, config),
      `${config.name}: the plan does not depend on the weights or the tokenizer`
    )
  }
})

test('a split of fit stubs projects the same plan as the full split', async function (t) {
  const { fullPath, fullSplit, stubSplit } = await ensureFixtures()
  t.is(stubSplit.length, SPLIT_COUNT, 'the split fixture has every shard')

  // Without this the cases below would pass on a first shard that happens to
  // hold the whole model, proving nothing about the other shards.
  t.ok(
    readGguf(stubSplit[0]).tensors.length < readGguf(fullPath).tensors.length,
    'the first shard alone is not the model'
  )

  // Ingest writes the key into every shard it stubs, not just the one carrying
  // the metadata, so the fixture has to as well.
  for (const [i, shard] of stubSplit.entries()) {
    t.is(kvValue(readGguf(shard), 'tokenizer.ggml.model'), 'none', `shard ${i + 1} declares it`)
  }

  // The loader derives the sibling shards from the first one, so passing the
  // first path is what fits the whole model.
  for (const config of CONFIGS) {
    t.alike(
      fitOk(t, stubSplit[0], config),
      fitOk(t, fullSplit[0], config),
      `${config.name}: every shard can be a stub`
    )
  }
})

test('the per-device projection probe runs on a fit stub', async function (t) {
  const { stubPath, stubSplit } = await ensureFixtures()

  // The projection comes from a second no_alloc load, and a probe that fails is
  // reported as an absent projection rather than as an error — which the plan
  // comparisons above would accept, since both sides would be empty. Assert the
  // rows exist.
  const [config] = CONFIGS
  for (const [shape, modelPath] of [
    ['single file', stubPath],
    ['2-way split', stubSplit[0]]
  ]) {
    const res = fitOk(t, modelPath, config)
    const projection = Array.isArray(res.projection) ? res.projection : []
    t.ok(projection.length >= 1, `${shape}: the probe produced rows`)
    if (projection.length === 0) continue

    t.is(projection[projection.length - 1].name, 'host', `${shape}: the trailing row is the host`)
    t.ok(
      projection.reduce((sum, row) => sum + row.modelBytes, 0) > 0,
      `${shape}: the weights were sized without a data section`
    )
  }
})

test('splitting a model does not change its plan', async function (t) {
  const { fullPath, fullSplit } = await ensureFixtures()

  for (const config of CONFIGS) {
    t.alike(
      fitOk(t, fullSplit[0], config),
      fitOk(t, fullPath, config),
      `${config.name}: the shard count is not a fit input`
    )
  }
})
