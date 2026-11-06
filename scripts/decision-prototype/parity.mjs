// QVAC-26667 prototype: compares the fabric bridge (@qvac/embed-llamacpp
// DecisionEngine) with llama-server built from the same fabric commit, on the
// same model, the same /v1/systemone bodies (requests.json) and the same
// settings. Each answer is compared by question type, against tolerances.json.
//
//   node scripts/decision-prototype/parity.mjs --server <llama-server> --model <m.gguf>
//        [--mmproj <f>] [--parallel 2] [--ctx 4096] [--cpu] [--bare <cmd>]
//
// Exits 1 on any exact mismatch, out-of-tolerance value, or error mismatch.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const server = opt('--server')
const model = opt('--model')
const mmproj = opt('--mmproj')
const parallel = opt('--parallel', '2')
const ctx = opt('--ctx', '4096')
const cpu = args.includes('--cpu')
const bare = (opt('--bare', 'bare') ?? 'bare').split(' ')
const port = Number(opt('--port', '19931'))
if (!server || !model) {
  console.error('✖ usage: parity.mjs --server <llama-server> --model <m.gguf> [--mmproj f] [--parallel N] [--ctx N] [--cpu]')
  process.exit(1)
}

const requests = JSON.parse(readFileSync(join(here, 'requests.json'), 'utf8'))
const tol = JSON.parse(readFileSync(join(here, 'tolerances.json'), 'utf8'))

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

async function bridgeResults() {
  const out = join(mkdtempSync(join(tmpdir(), 'decision-parity-')), 'bridge.json')
  const collector = join(here, '..', '..', 'packages', 'embed-llamacpp', 'scripts', 'decision-parity-collect.js')
  const argv = [...bare.slice(1), collector, join(here, 'requests.json'), model, out, '--parallel', parallel, '--ctx', ctx]
  if (mmproj) argv.push('--mmproj', mmproj)
  if (cpu) argv.push('--cpu')
  await run(bare[0], argv)
  return JSON.parse(readFileSync(out, 'utf8'))
}

async function serverResults() {
  const argv = ['-m', model, '--port', String(port), '-np', parallel, '-c', ctx, '-ngl', cpu ? '0' : '99']
  if (mmproj) argv.push('--mmproj', mmproj)
  const child = spawn(server, argv, { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break
      } catch {}
      if (i > 600) throw new Error('llama-server did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const results = []
    for (const { name, body } of requests) {
      const res = await fetch(`${base}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const json = await res.json()
      results.push(res.ok ? { name, ok: true, result: json } : { name, ok: false, status: res.status, error: json.error })
    }
    return results
  } finally {
    child.kill()
  }
}

const problems = []
const stats = { compared: 0, maxProbability: 0, maxNoul: 0, maxScore: 0, maxConfidence: 0 }

function close(label, a, b, limit, key) {
  const diff = Math.abs(a - b)
  stats[key] = Math.max(stats[key], diff)
  if (!(diff <= limit)) problems.push(`${label}: ${a} vs ${b} (diff ${diff.toExponential(2)} > ${limit})`)
}
function same(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
}

function compareAnswer(label, a, b) {
  same(`${label} type`, a.type, b.type)
  if (a.type === 'choice') {
    same(`${label} choice`, a.choice, b.choice)
  }
  if (a.type === 'choice' || a.type === 'score') {
    same(`${label} probability keys`, Object.keys(a.probabilities).sort(), Object.keys(b.probabilities).sort())
    for (const k of Object.keys(a.probabilities)) close(`${label} p(${k})`, a.probabilities[k], b.probabilities[k], tol.probability, 'maxProbability')
    close(`${label} confidence`, a.confidence, b.confidence, tol.confidence, 'maxConfidence')
  }
  if (a.type === 'score') {
    close(`${label} score`, a.score, b.score, tol.score, 'maxScore')
    same(`${label} legend`, a.legend, b.legend)
  }
  if (a.type === 'noul') {
    close(`${label} noul`, a.noul, b.noul, tol.noul, 'maxNoul')
    same(`${label} has confidence`, 'confidence' in a, 'confidence' in b)
  }
}

const [bridge, reference] = [await bridgeResults(), await serverResults()]
for (let i = 0; i < requests.length; i++) {
  const name = requests[i].name
  const a = bridge[i]
  const b = reference[i]
  if (a.ok !== b.ok) {
    problems.push(`${name}: bridge ${a.ok ? 'answered' : 'rejected'}, llama-server ${b.ok ? 'answered' : 'rejected'}`)
    continue
  }
  if (!a.ok) {
    // Both rejected: the bridge must report an invalid request where llama-server says 400.
    if (b.status === 400 && a.error.code !== 'DECISION_INVALID_REQUEST') {
      problems.push(`${name}: llama-server 400 but bridge error code ${a.error.code}`)
    }
    stats.compared++
    continue
  }
  same(`${name} input_tokens`, a.result.usage.input_tokens, b.result.usage.input_tokens)
  same(`${name} questions`, Object.keys(a.result.answers).sort(), Object.keys(b.result.answers).sort())
  for (const id of Object.keys(a.result.answers)) compareAnswer(`${name} / ${id}`, a.result.answers[id], b.result.answers[id])
  stats.compared++
}

console.log(JSON.stringify({ model, requests: requests.length, ...stats, tolerances: tol, problems }, null, 2))
process.exitCode = problems.length === 0 ? 0 : 1
