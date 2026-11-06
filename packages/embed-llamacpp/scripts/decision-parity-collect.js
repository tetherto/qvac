'use strict'

// QVAC-26667 prototype: runs a list of /v1/systemone requests through this
// package's DecisionEngine (the fabric bridge) and writes each answer, or the
// error, to a JSON file. Runs under Bare; scripts/decision-prototype/parity.mjs
// at the repo root starts it.
//
//   bare scripts/decision-parity-collect.js <requests.json> <model.gguf> <out.json>
//        [--mmproj <file>] [--parallel N] [--ctx N] [--cpu]

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

const args = process.argv.slice(2)
const [requestsFile, model, out] = args
const opt = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

if (!requestsFile || !model || !out) {
  console.error(
    '✖ usage: bare decision-parity-collect.js <requests.json> <model.gguf> <out.json> [--mmproj f] [--parallel N] [--ctx N] [--cpu]'
  )
  process.exit(1)
}

const { DecisionEngine } = require(path.join(__dirname, '..', 'index.js'))

async function main() {
  const requests = JSON.parse(fs.readFileSync(requestsFile, 'utf8'))
  const config = args.includes('--cpu') ? { device: 'cpu' } : { device: 'gpu', gpu_layers: '99' }
  if (opt('--mmproj')) config.mmproj = opt('--mmproj')
  if (opt('--parallel')) config.parallel = opt('--parallel')
  if (opt('--ctx')) config.ctx_size = opt('--ctx')

  const engine = new DecisionEngine({ files: { model: [model] }, config })
  await engine.load()
  const results = []
  try {
    console.error(
      `▸ ${engine.info().decision_type}: ${requests.length} requests through the bridge`
    )
    for (const { name, body } of requests) {
      try {
        const [result] = await (await engine.run(body)).await()
        results.push({ name, ok: true, result })
      } catch (error) {
        results.push({
          name,
          ok: false,
          error: { code: error.code ?? null, message: error.message }
        })
      }
    }
  } finally {
    await engine.unload()
  }
  fs.writeFileSync(out, JSON.stringify(results, null, 2))
}

main().catch((error) => {
  console.error('✖', error)
  process.exitCode = 1
})
