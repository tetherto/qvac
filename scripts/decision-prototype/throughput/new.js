'use strict'

// New path: @qvac/decision-ggml DecisionEngine on the upstream-format Laya GGUF.
// Run with this checkout's packages/decision-ggml as <decision-ggml-dir>.
// Usage: bare new.js <decision-ggml-dir> <upstream-format.gguf> <gpu|cpu> <reps> <mode> [config JSON]
//   mode seq:   one run per state, in order
//   mode batch: one run with `states`, as decide() sends a batch
//   config:     extra load options, e.g. '{"parallel":"1"}'

const [decisionDir, modelPath, device = 'gpu', repsArg = '5', mode = 'batch', extra = '{}'] = Bare.argv.slice(2)
const { DecisionEngine } = require(decisionDir)
const { states, questions, stats } = require('./workload.js')

async function main () {
  const config = device === 'cpu' ? { device: 'cpu' } : { device: 'gpu', gpu_layers: '99' }
  Object.assign(config, JSON.parse(extra))
  const engine = new DecisionEngine({ files: { model: [modelPath] }, config })
  await engine.load()

  async function batch (list) {
    const t = Date.now()
    let results
    if (mode === 'seq') {
      results = []
      for (const state of list) {
        const [result] = await (await engine.run({ state, questions })).await()
        results.push(result)
      }
    } else {
      [results] = await (await engine.run({ states: list, questions })).await()
    }
    return { ms: Date.now() - t, results }
  }

  await batch(states) // warm-up
  const reps = Number(repsArg)
  const batchMs = []
  let sample
  for (let i = 0; i < reps; i++) {
    const { ms, results } = await batch(states)
    batchMs.push(ms)
    sample = results
  }
  const singleMs = []
  for (let i = 0; i < reps; i++) singleMs.push((await batch([states[0]])).ms)

  console.log(JSON.stringify({
    path: `new: decision-ggml DecisionEngine (upstream-format), ${mode}`,
    config,
    device,
    states: states.length,
    batch32: stats(batchMs),
    single: stats(singleMs),
    sample: {
      count: sample.length,
      department: sample[0].answers.department.choice,
      refund: sample[0].answers.refund.noul,
      last: sample[31].answers.department.choice
    }
  }))
  await engine.unload()
}

main().catch((err) => { console.error(err); Bare.exit(1) })
