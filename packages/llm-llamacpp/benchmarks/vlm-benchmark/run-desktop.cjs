'use strict'
// Desktop run helper. Its only live entry point is `--selfcheck`, which validates this
// folder's contract wiring without running a model: config loads, scenarios resolve, the
// models grammar parses, and the sample markers file matches the v2 schema. CI and devs
// run it cheaply. (A process-level block-scheduling driver was scoped here but not pursued
// — the harness runs candidate/baseline, warmup/stability, and RSS per process directly.)

const fs = require('fs')
const path = require('path')

function selfcheck () {
  const config = require('./config.cjs')
  const { parseModels } = require('./models.cjs')
  const { parseSources } = require('./sources.cjs')
  const { planBlocks } = require('./methodology.cjs')
  const problems = []

  // config/scenario invariants
  if (!config.scenarios || !config.scenarios[config.defaultScenario]) problems.push('defaultScenario missing from scenarios')
  for (const name of config.defaultModels || []) {
    if (!config.catalog || !config.catalog[name]) problems.push(`defaultModels entry '${name}' not in catalog`)
  }

  // grammar round-trips
  parseModels('qwen3.5-f16,qwen3.5-q8', config.catalog, config.models)
  parseModels('t=https://huggingface.co/org/repo/resolve/0123456789012345678901234567890123456789/m.gguf|https://example.com/p.gguf@ctx=8192', config.catalog, [])
  parseSources('addon,addon@candidate,fabric@v8189.0.2,upstream@b8189')
  if (planBlocks(['a', 'b'], config.methodology).length < 2) problems.push('planBlocks produced no plan')

  // sample markers conform to the v2 contract
  // .txt, not .log — the package-level .gitignore swallows *.log
  const sample = fs.readFileSync(path.join(__dirname, 'markers-v2.sample.txt'), 'utf8')
  const need = ['v', 'scenario', 'source_id', 'source_ref', 'block', 'cell', 'model', 'device', 'task', 'metric']
  let rows = 0
  for (const line of sample.split(/\r?\n/)) {
    const m = line.match(/\[VLMROW\](.*?)\[\/VLMROW\]/)
    if (!m) continue
    rows++
    const r = JSON.parse(m[1])
    if (r.v === undefined) continue // a deliberate legacy (v1) row in the sample
    for (const k of need) if (!(k in r)) problems.push(`sample row ${rows} missing '${k}'`)
  }
  if (rows < 10) problems.push(`sample markers file has only ${rows} rows`)

  if (problems.length) {
    console.error('selfcheck FAILED:\n  - ' + problems.join('\n  - '))
    process.exit(1)
  }
  console.log(`selfcheck OK (${rows} sample rows, ${Object.keys(config.catalog).length} catalog models, ${Object.keys(config.scenarios).length} scenarios)`)
}

if (require.main === module) {
  if (process.argv.includes('--selfcheck')) selfcheck()
  else {
    console.error('run-desktop.cjs: only --selfcheck is implemented')
    process.exit(2)
  }
}

module.exports = { selfcheck }
