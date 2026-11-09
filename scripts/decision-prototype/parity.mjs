// QVAC-26667 prototype: compares @qvac/decision-ggml's DecisionEngine
// (upstream server-context, in-process) with llama-server built from the same
// fabric commit, on the same model, the same /v1/systemone bodies
// (requests.json) and the same settings. Each request declares its expected outcome ("expect"): an answer,
// compared by question type against tolerances.json, or a rejection, whose
// status, code and message both engines must match.
//
//   node scripts/decision-prototype/parity.mjs --server <llama-server> --model <m.gguf>
//        [--mmproj <f>] [--parallel 2] [--ctx 4096] [--cpu] [--bare <cmd>] [--port N]
//
// Exits 1 on any unexpected outcome, exact mismatch, out-of-tolerance value or
// error mismatch.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const server = opt('--server')
const model = opt('--model') && resolve(opt('--model'))
const mmproj = opt('--mmproj') && resolve(opt('--mmproj'))
const parallel = opt('--parallel', '2')
const ctx = opt('--ctx', '4096')
const cpu = args.includes('--cpu')
const bare = (opt('--bare', 'bare') ?? 'bare').split(' ')
const requestedPort = opt('--port') === undefined ? undefined : Number(opt('--port'))
if (!server || !model) {
  console.error('✖ usage: parity.mjs --server <llama-server> --model <m.gguf> [--mmproj f] [--parallel N] [--ctx N] [--cpu]')
  process.exit(1)
}

const requests = JSON.parse(readFileSync(join(here, 'requests.json'), 'utf8'))
for (const { name, expect } of requests) {
  const rejection =
    expect !== null &&
    typeof expect === 'object' &&
    Number.isInteger(expect.status) &&
    typeof expect.code === 'string' &&
    typeof expect.message === 'string' &&
    expect.message !== ''
  if (expect !== 'answer' && !rejection) {
    console.error(`✖ requests.json: "${name}" needs "expect": "answer" or { "status", "code", "message" }`)
    process.exit(1)
  }
}
const tol = JSON.parse(readFileSync(join(here, 'tolerances.json'), 'utf8'))

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

async function addonResults() {
  const out = join(mkdtempSync(join(tmpdir(), 'decision-parity-')), 'addon.json')
  const collector = join(here, '..', '..', 'packages', 'decision-ggml', 'scripts', 'decision-parity-collect.js')
  const argv = [...bare.slice(1), collector, join(here, 'requests.json'), model, out, '--parallel', parallel, '--ctx', ctx]
  if (mmproj) argv.push('--mmproj', mmproj)
  if (cpu) argv.push('--cpu')
  await run(bare[0], argv)
  return JSON.parse(readFileSync(out, 'utf8'))
}

// A port nothing listens on: the requested one, checked, or a free one.
function freePort(port = 0) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) =>
      reject(error.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use`) : error)
    )
    probe.listen(port, '127.0.0.1', () => {
      const { port: free } = probe.address()
      probe.close(() => resolve(free))
    })
  })
}

async function serverResults() {
  const port = await freePort(requestedPort)
  const argv = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-np', parallel, '-c', ctx, '-ngl', cpu ? '0' : '99']
  if (mmproj) argv.push('--mmproj', mmproj)
  // decision-ggml keeps the projector on the CPU with --cpu; so must the reference.
  if (mmproj && cpu) argv.push('--no-mmproj-offload')
  const child = spawn(server, argv, { stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  child.stderr.on('data', (chunk) => {
    log = (log + chunk).slice(-4000)
  })
  let exit
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve((exit = `failed to start: ${error.message}`)))
    child.once('exit', (code, signal) => resolve((exit = `exited ${signal ?? code}`)))
  })
  const fail = (why) => new Error(`llama-server ${why}\n${log}`)
  try {
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; ; i++) {
      if (exit) throw fail(`${exit} before it was ready`)
      try {
        if ((await fetch(`${base}/health`)).ok) break
      } catch {}
      if (i > 600) throw fail('did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // The endpoint must be the server just launched, on the requested model.
    const props = await (await fetch(`${base}/props`)).json()
    if (exit) throw fail(`${exit} while starting`)
    if (props.model_path !== model) {
      throw fail(`on port ${port} serves ${props.model_path}, not ${model}`)
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
    if (exit) throw fail(`${exit} during the run`)
    return results
  } finally {
    if (!exit) child.kill()
    await exited
  }
}

const problems = []
const stats = { answered: 0, rejected: 0, maxProbability: 0, maxNoul: 0, maxScore: 0, maxConfidence: 0 }

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

let addon, reference
try {
  addon = await addonResults()
  reference = await serverResults()
} catch (error) {
  console.error(`✖ ${error.message}`)
  process.exit(1)
}
const failure = {
  addon: (r) => `${r.error.code}: ${r.error.message}`,
  server: (r) => `HTTP ${r.status}: ${r.error?.message}`
}
for (let i = 0; i < requests.length; i++) {
  const { name, expect } = requests[i]
  const a = addon[i]
  const b = reference[i]
  if (a?.name !== name || b?.name !== name) {
    problems.push(`${name}: missing from the addon or llama-server results`)
    continue
  }
  if (expect !== 'answer') {
    // Expected rejection: llama-server's status, the addon's code, and the
    // same upstream message from both.
    if (a.ok) problems.push(`${name}: addon answered, expected a rejection`)
    else {
      if (a.error.code !== expect.code) problems.push(`${name}: addon ${failure.addon(a)}, expected code ${expect.code}`)
      if (!a.error.message.includes(expect.message)) problems.push(`${name}: addon message "${a.error.message}" lacks "${expect.message}"`)
    }
    if (b.ok) problems.push(`${name}: llama-server answered, expected a rejection`)
    else {
      if (b.status !== expect.status) problems.push(`${name}: llama-server ${failure.server(b)}, expected HTTP ${expect.status}`)
      if (!b.error?.message?.includes(expect.message)) problems.push(`${name}: llama-server message "${b.error?.message}" lacks "${expect.message}"`)
    }
    if (!a.ok && !b.ok && !a.error.message.includes(b.error?.message)) {
      problems.push(`${name}: messages differ: addon "${a.error.message}", llama-server "${b.error?.message}"`)
    }
    stats.rejected++
    continue
  }
  if (!a.ok) problems.push(`${name}: addon failed, expected an answer: ${failure.addon(a)}`)
  if (!b.ok) problems.push(`${name}: llama-server failed, expected an answer: ${failure.server(b)}`)
  if (!a.ok || !b.ok) continue
  same(`${name} input_tokens`, a.result.usage.input_tokens, b.result.usage.input_tokens)
  same(`${name} questions`, Object.keys(a.result.answers).sort(), Object.keys(b.result.answers).sort())
  for (const id of Object.keys(a.result.answers)) {
    if (b.result.answers[id]) compareAnswer(`${name} / ${id}`, a.result.answers[id], b.result.answers[id])
  }
  stats.answered++
}

console.log(JSON.stringify({ model, requests: requests.length, ...stats, tolerances: tol, problems }, null, 2))
process.exitCode = problems.length === 0 ? 0 : 1
