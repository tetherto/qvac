'use strict'

const os = require('bare-os')
const path = require('bare-path')
const { Reranker } = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')

// Load options are checked before the file is read, so the config tests below
// need no model.
const NO_MODEL = '/nonexistent/reranker.gguf'
const MODEL = 'jina-reranker-v1-tiny-en-f16.gguf'

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

const CPU = { device: 'cpu' }
// As the other embed tests: these runners load on the CPU.
const GPU = isDarwinX64 || isLinuxArm64 || isMobile ? CPU : { device: 'gpu', gpu_layers: '99' }

// llama-server's rerank test: document 2 answers the query, document 3 is in
// French about Paris.
const QUERY = 'Machine learning is'
const DOCUMENTS = [
  'A machine is a physical system that uses power to apply forces and control movement to perform an action. The term is commonly applied to artificial devices, such as those employing engines or motors, but also to natural biological macromolecules, such as molecular machines.',
  'Learning is the process of acquiring new understanding, knowledge, behaviors, skills, values, attitudes, and preferences. The ability to learn is possessed by humans, non-human animals, and some machines; there is also evidence for some kind of learning in certain plants.',
  'Machine learning is a field of study in artificial intelligence concerned with the development and study of statistical algorithms that can learn from data and generalize to unseen data, and thus perform tasks without explicit instructions.',
  "Paris, capitale de la France, est une grande ville européenne et un centre mondial de l'art, de la mode, de la gastronomie et de la culture. Son paysage urbain du XIXe siècle est traversé par de larges boulevards et la Seine."
]

async function modelPath() {
  const [name, dir] = await ensureModel({ modelName: MODEL })
  return path.join(dir, name)
}

async function withReranker(t, config, fn, opts = { stats: true }) {
  const reranker = new Reranker({ files: { model: [await modelPath()] }, config, opts })
  try {
    await reranker.load()
    return await fn(reranker)
  } finally {
    await reranker.unload().catch((err) => t.comment(`unload failed: ${err.message}`))
  }
}

async function score(reranker, request) {
  const response = await reranker.run(request)
  const [scores] = await response.await()
  return { scores, stats: response.stats }
}

const argmax = (xs) => xs.indexOf(Math.max(...xs))
const argmin = (xs) => xs.indexOf(Math.min(...xs))

safeTest('the answering document scores highest', { timeout: 600_000 }, async (t) => {
  await withReranker(t, GPU, async (reranker) => {
    const { scores, stats } = await score(reranker, { query: QUERY, documents: DOCUMENTS })

    t.is(scores.length, DOCUMENTS.length, 'one score per document')
    t.ok(
      scores.every((s) => typeof s === 'number' && Number.isFinite(s)),
      'scores are numbers'
    )
    t.is(argmax(scores), 2, `most relevant: ${scores}`)
    t.is(argmin(scores), 3, `least relevant: ${scores}`)

    t.is(stats.documents, DOCUMENTS.length)
    t.is(stats.forward_passes, 1, 'every pair fits one pass')
    t.ok(
      ['cpu', 'gpu'].includes(stats.backendDevice),
      `backendDevice is named (${stats.backendDevice})`
    )
  })
})

safeTest('each document scores as it would alone', { timeout: 600_000 }, async (t) => {
  await withReranker(t, GPU, async (reranker) => {
    const { scores } = await score(reranker, { query: QUERY, documents: DOCUMENTS })
    for (const [i, document] of DOCUMENTS.entries()) {
      const { scores: alone } = await score(reranker, { query: QUERY, documents: [document] })
      t.ok(Math.abs(alone[0] - scores[i]) < 1e-2, `document ${i}: ${alone[0]} vs ${scores[i]}`)
    }
  })
})

safeTest('the CPU and the GPU rank the same', { timeout: 600_000 }, async (t) => {
  const request = { query: QUERY, documents: DOCUMENTS }
  const onGpu = await withReranker(t, GPU, async (r) => (await score(r, request)).scores)
  const onCpu = await withReranker(t, CPU, async (r) => (await score(r, request)).scores)
  t.is(argmax(onCpu), argmax(onGpu))
  for (const [i, s] of onCpu.entries()) {
    t.ok(Math.abs(s - onGpu[i]) < 1e-2, `document ${i}: ${s} vs ${onGpu[i]}`)
  }
})

safeTest('no documents give no scores', { timeout: 600_000 }, async (t) => {
  await withReranker(t, GPU, async (reranker) => {
    const { scores } = await score(reranker, { query: QUERY, documents: [] })
    t.alike(scores, [])
  })
})

safeTest(
  'a pair longer than the batch fails without breaking the instance',
  { timeout: 600_000 },
  async (t) => {
    await withReranker(t, { ...GPU, batch_size: '64' }, async (reranker) => {
      await t.exception(
        async () => (await reranker.run({ query: QUERY, documents: DOCUMENTS })).await(),
        /increase batch_size/
      )
      const { scores } = await score(reranker, { query: QUERY, documents: ['short'] })
      t.is(scores.length, 1)
    })
  }
)

safeTest('cancel stops a running request', { timeout: 600_000 }, async (t) => {
  await withReranker(t, CPU, async (reranker) => {
    // Long enough on any CPU that the cancel lands while it runs.
    const documents = Array.from({ length: 4096 }, (_, i) => `${DOCUMENTS[i % 4]} (#${i})`)
    const response = await reranker.run({ query: QUERY, documents })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await reranker.cancel()
    await t.exception(response.await(), /Job cancelled/)

    const { scores } = await score(reranker, { query: QUERY, documents: DOCUMENTS })
    t.is(argmax(scores), 2)
  })
})

safeTest('a request that is not query and documents is refused', {}, async (t) => {
  // TypeErrors: t.exception rethrows native errors, t.exception.all does not.
  const reranker = new Reranker({ files: { model: [NO_MODEL] }, config: CPU })
  await t.exception.all(reranker.run({ query: QUERY }), /request.documents must be an array/)
  await t.exception.all(reranker.run({ documents: DOCUMENTS }), /request.query must be a string/)
  await t.exception.all(
    reranker.run({ query: QUERY, documents: ['a', 1] }),
    /request.documents\[1\] must be a string/
  )
})

safeTest('load rejects an option a reranker does not take', {}, async (t) => {
  const reranker = new Reranker({
    files: { model: [NO_MODEL] },
    config: { ...GPU, pooling: 'rank' }
  })
  try {
    await reranker.load()
    t.fail('load must reject')
  } catch (err) {
    t.is(err.code, '[ GTE :: InvalidConfiguration ]', err.message)
  } finally {
    await reranker.unload().catch(() => {})
  }
})

safeTest('load rejects an embedding model', { timeout: 600_000 }, async (t) => {
  const [name, dir] = await ensureModel({ modelName: 'embeddinggemma-300M-Q8_0.gguf' })
  const reranker = new Reranker({ files: { model: [path.join(dir, name)] }, config: GPU })
  try {
    await reranker.load()
    t.fail('load must reject')
  } catch (err) {
    t.is(err.code, '[ GTE :: UnsupportedModel ]', err.message)
  } finally {
    await reranker.unload().catch(() => {})
  }
})

safeTest('run before load is refused', {}, (t) => {
  const reranker = new Reranker({ files: { model: [NO_MODEL] }, config: CPU })
  return t.exception(reranker.run({ query: QUERY, documents: DOCUMENTS }), /Call load\(\) first/)
})
