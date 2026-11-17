'use strict'

// Old path: published @qvac/embed-llamacpp LayaDecisions on a Fabric-format
// Laya GGUF. All states in one call (`states`), as production decide() does.
// Usage: bare old.js <embed-dir> <fabric-format.gguf> <gpu|cpu> [reps]

const [embedDir, modelPath, device = 'gpu', repsArg = '5'] = Bare.argv.slice(2)
const { LayaDecisions } = require(embedDir)
const { states, questions, stats } = require('./workload.js')

async function main () {
  const config = device === 'cpu' ? { device: 'cpu' } : { device: 'gpu', gpu_layers: '99' }
  const laya = new LayaDecisions({ files: { model: [modelPath] }, config })
  await laya.load()

  async function batch (list) {
    const t = Date.now()
    const response = await laya.run({ states: list, questions })
    const [results] = await response.await()
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
    path: 'old: embed LayaDecisions (fabric-format)',
    device,
    states: states.length,
    batch32: stats(batchMs),
    single: stats(singleMs),
    sample: { department: sample[0].answers.department.choice, refund: sample[0].answers.refund.noul }
  }))
  await laya.unload()
}

main().catch((err) => { console.error(err); Bare.exit(1) })
