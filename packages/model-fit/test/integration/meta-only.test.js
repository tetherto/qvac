'use strict'

// The fitter loads with no_alloc and no mmap, so it never reads tensor data: a
// metadata-only GGUF — header, KV pairs and tensor infos, nothing after them —
// carries everything the projection needs. Callers that only have the header
// (a download that has not finished, a registry that serves metadata alone)
// must therefore get the same plan as the full artefact, through the same API
// and with the file at its real length: no padding to the full size, which
// NTFS would allocate for real.
//
// The fitter's own bounds check used to reject that file. qvac-fabric
// 10549.0.0 makes it conditional on the load actually reading data, so these
// cases fail on any fabric older than the pin in packages/fabric.

const test = require('brittle')
const fs = require('bare-fs')
const process = require('bare-process')
const { fitParams, FIT_STATUS } = require('../../index.js')
const { ensureModelPath } = require('./utils')
const { fixturePath, readGguf, writeMetaOnly, writeSplit } = require('./gguf')

const SPLIT_COUNT = 2

// Two shapes of request, so the comparison is not a single accidental path:
// one the fitter is free to place, one pinned to the CPU.
const CONFIGS = [
  { name: 'fitter-placed', nCtx: 2048, nCtxMin: 512, marginMiB: 1024 },
  { name: 'CPU-pinned', nCtx: 2048, marginMiB: 1024, nGpuLayers: 0, splitMode: 0, mainGpu: -1 }
]

let fixtures = null

// Built once: the split fixture copies the artefact, and FIT_MODEL_PATH may
// point at a real multi-gigabyte model.
async function ensureFixtures() {
  if (fixtures) return fixtures

  const fullPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  fixtures = {
    fullPath,
    metaOnlyPath: writeMetaOnly(fullPath, fixturePath('meta-only.gguf')),
    fullSplit: writeSplit(fullPath, fixturePath('split-full'), { splitCount: SPLIT_COUNT }),
    metaOnlySplit: writeSplit(fullPath, fixturePath('split-meta-only'), {
      splitCount: SPLIT_COUNT,
      metaOnly: true
    })
  }
  return fixtures
}

function fitOk(t, modelPath, config) {
  const { name, ...request } = config
  const res = fitParams({ modelPath, ...request })
  t.not(res.status, FIT_STATUS.ERROR, `${name}: the fitter read the model`)
  return res
}

test('a metadata-only GGUF is the full file truncated at its data section', async function (t) {
  const { fullPath, metaOnlyPath } = await ensureFixtures()
  const { dataOffset } = readGguf(fullPath)

  const metaOnlySize = fs.statSync(metaOnlyPath).size
  t.is(metaOnlySize, dataOffset, 'the stub ends where the tensor data begins')
  t.ok(metaOnlySize < fs.statSync(fullPath).size, 'the stub is shorter than the artefact')
})

test('a metadata-only GGUF projects the same plan as the full file', async function (t) {
  const { fullPath, metaOnlyPath } = await ensureFixtures()

  for (const config of CONFIGS) {
    t.alike(
      fitOk(t, metaOnlyPath, config),
      fitOk(t, fullPath, config),
      `${config.name}: the plan does not depend on the data section`
    )
  }
})

test('a metadata-only split projects the same plan as the full split', async function (t) {
  const { fullPath, fullSplit, metaOnlySplit } = await ensureFixtures()
  t.is(metaOnlySplit.length, SPLIT_COUNT, 'the split fixture has every shard')

  // Without this the cases below would pass on a first shard that happens to
  // hold the whole model, proving nothing about the other shards.
  t.ok(
    readGguf(metaOnlySplit[0]).tensors.length < readGguf(fullPath).tensors.length,
    'the first shard alone is not the model'
  )

  // The loader derives the sibling shards from the first one, so passing the
  // first path is what fits the whole model.
  for (const config of CONFIGS) {
    t.alike(
      fitOk(t, metaOnlySplit[0], config),
      fitOk(t, fullSplit[0], config),
      `${config.name}: every shard can be metadata-only`
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
