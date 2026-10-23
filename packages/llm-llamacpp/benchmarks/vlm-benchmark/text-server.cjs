#!/usr/bin/env node
'use strict'
// Text suite, llama-server leg (Node >= 18). Runs ONE job of the plan (written by
// run-local.cjs): starts llama-server with that job's slots / speculative settings,
// sends the same requests as text-addon.js and prints the same [TEXTROW] /
// [TEXTBATCH] markers, then stops the server.
//
//   node text-server.cjs --binary <llama-server> --plan <plan.json>

const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const crypto = require('crypto')
const { parseArgs } = require('./utils')
const { serverArgs, serverEnv, stopServer, portFree, startRssSampler, waitHealthy, postStream } = require('./server-runner.cjs')
const W = require('./text-workload.cjs')

const ENGINE = 'llama-server'
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000

function emit (tag, obj) { console.log(`[${tag}]` + JSON.stringify(obj) + `[/${tag}]`) }

function rowBase (plan, job) {
  const draft = W.draftModelFor(plan, job)
  return { engine: ENGINE, backend: plan.backend, model: plan.label, source_ref: plan.sourceRef, job: job.id, suite: job.suite, conc: job.parallel, spec: job.spec || 'none', draft_model: draft ? path.basename(draft) : null }
}

function specArgs (plan, job) {
  if (!job.spec || job.spec === 'none') return []
  const gpu = plan.backend === 'gpu'
  const args = ['--spec-type', job.spec]
  const draft = W.draftModelFor(plan, job)
  if (W.DRAFT_MODEL_SPEC_TYPES.includes(job.spec) && !draft) throw new Error(`spec type ${job.spec} needs a draft model (--draft <gguf>)`)
  if (draft) {
    // The addon offloads the draft / MTP head like the target (--gpu-layers).
    const ngl = gpu ? String(plan.params && plan.params.gpuLayers != null ? plan.params.gpuLayers : 99) : '0'
    args.push('--model-draft', draft, '--spec-draft-ngl', ngl)
    if (!gpu) args.push('--spec-draft-device', 'none')
  }
  if (plan.specDraftNMax != null) args.push('--spec-draft-n-max', String(plan.specDraftNMax))
  return args
}

async function startServer (binary, plan, job) {
  const apiKey = crypto.randomBytes(16).toString('hex')
  const headers = { Authorization: `Bearer ${apiKey}` }
  const params = { ...plan.params, ctxSize: job.ctx }
  delete params.imageMaxTokens
  // Verbosity 2: the text suite reads nothing from the server log but failure reasons.
  const a = { llm: plan.llm, backend: plan.backend, port: plan.port, parallel: job.parallel, verbosity: 2 }
  const args = [...serverArgs(a, params), ...specArgs(plan, job)]
  if (!(await portFree(plan.port))) throw new Error(`port ${plan.port} is already in use; pass --port <free port>`)
  console.error(`[text-server] ${job.id}: ${binary} ${args.join(' ')}`)
  const child = cp.spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(binary), env: serverEnv(apiKey) })
  const logStream = plan.serverLog ? fs.createWriteStream(plan.serverLog, { flags: 'a' }) : null
  if (logStream) logStream.write(`\n===== ${job.id} =====\n`)
  // Tail of the server output, so a failed start can say why (e.g. no MTP layers).
  let tail = ''
  const onData = d => {
    if (logStream && !logStream.writableEnded) logStream.write(d)
    tail = (tail + d.toString()).slice(-8192)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const stop = () => stopServer(child, logStream)
  process.on('SIGINT', () => { if (child.exitCode == null) child.kill(); process.exit(130) })
  process.on('SIGTERM', () => { if (child.exitCode == null) child.kill(); process.exit(143) })
  try {
    await waitHealthy(`http://127.0.0.1:${plan.port}`, child, headers)
  } catch (e) {
    await stop()
    const why = tail.split('\n').filter(l => / [EW] /.test(l)).slice(-4).join('\n  ')
    throw new Error(`${e.message}${why ? `\n  ${why}` : ''}`)
  }
  return { base: `http://127.0.0.1:${plan.port}`, headers, rss: startRssSampler(child.pid), stop }
}

// One streamed chat completion, timed client-side from the request start.
async function request (srv, messages, maxTokens, ignoreEos) {
  const body = JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0, seed: 42, stream: true, cache_prompt: false, ignore_eos: !!ignoreEos })
  let first = null
  let last = null
  let timings = null
  let finish = null
  const t0 = Date.now()
  await postStream(`${srv.base}/v1/chat/completions`, srv.headers, body, REQUEST_TIMEOUT_MS, evt => {
    if (evt.error) throw new Error(`server error: ${JSON.stringify(evt.error).slice(0, 500)}`)
    const choice = evt.choices && evt.choices[0]
    if (choice && choice.delta && choice.delta.content) {
      const now = Date.now() - t0
      if (first == null) first = now
      last = now
    }
    if (choice && choice.finish_reason) finish = choice.finish_reason
    if (evt.timings) timings = evt.timings
  })
  const t = timings || {}
  const gen = t.predicted_n != null ? t.predicted_n : null
  return {
    prompt_tokens: t.prompt_n != null ? t.prompt_n + (t.cache_n || 0) : null,
    gen_tokens: gen,
    ttft_ms: t.prompt_ms != null ? t.prompt_ms : null,
    pp_tps: t.prompt_per_second != null ? t.prompt_per_second : null,
    decode_tps: t.predicted_per_second != null ? t.predicted_per_second : null,
    client_ttft_ms: first,
    client_decode_tps: W.clientDecodeTps(gen, first, last),
    wall_ms: Date.now() - t0,
    stop: finish,
    draft_n: t.draft_n != null ? t.draft_n : null,
    draft_accepted: t.draft_n_accepted != null ? t.draft_n_accepted : null
  }
}

function readCalibration (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null }
}

async function runJob (srv, plan, job) {
  const base = rowBase(plan, job)

  if (job.suite === 'calibrate') {
    const out = {}
    for (const target of job.targets) {
      const r = await W.calibrate(target, async n => (await request(srv, W.messagesFor(n, 0), 1, false)).prompt_tokens)
      out[target] = r
      console.error(`[text-server] calibrated ${target} tokens -> ${r.words} words (${r.tokens} tokens)`)
    }
    fs.writeFileSync(plan.calibrationFile, JSON.stringify({ engine: ENGINE, llm: plan.llm, targets: out }, null, 2))
    return
  }

  const cal = readCalibration(plan.calibrationFile)
  const wordsFor = t => {
    const c = cal && cal.targets && cal.targets[t]
    if (!c) throw new Error(`no calibration for a ${t}-token prompt in ${plan.calibrationFile}`)
    return c.words
  }
  let nonce = 1

  if (job.suite === 'single') {
    for (const target of job.prompts) {
      const words = wordsFor(target)
      for (let rep = 0; rep <= job.repeats; rep++) {
        const r = await request(srv, W.messagesFor(words, nonce++), job.gen, job.ignoreEos)
        emit('TEXTROW', { ...base, prompt_target: target, rep, warmup: rep === 0, ...r, rss_mb: await srv.rss.peak() })
      }
    }
    return
  }

  const rounds = job.suite === 'conc' ? job.rounds : job.runs
  for (let round = 0; round <= rounds; round++) {
    let batches
    if (job.suite === 'conc') {
      const reqs = []
      for (let i = 0; i < job.parallel; i++) reqs.push({ kind: 'filler', target: job.prompt, messages: W.messagesFor(wordsFor(job.prompt), nonce++) })
      batches = [reqs]
    } else if (job.parallel === 1) {
      batches = job.prompts.map(id => [{ kind: id, target: null, messages: [{ role: 'user', content: W.specPrompt(id) }] }])
    } else {
      const reqs = []
      for (let i = 0; i < job.parallel; i++) {
        const id = job.prompts[(round * job.parallel + i) % job.prompts.length]
        reqs.push({ kind: id, target: null, messages: [{ role: 'user', content: W.specPrompt(id) }] })
      }
      batches = [reqs]
    }
    for (const batch of batches) {
      const t0 = Date.now()
      const rs = await Promise.all(batch.map(q => request(srv, q.messages, job.gen, job.ignoreEos).catch(e => ({ error: String((e && e.message) || e) }))))
      const wall = Date.now() - t0
      let gen = 0
      rs.forEach((r, i) => {
        if (r.gen_tokens) gen += r.gen_tokens
        emit('TEXTROW', { ...base, round, warmup: round === 0, req: i, kind: batch[i].kind, prompt_target: batch[i].target, ...r })
      })
      emit('TEXTBATCH', { ...base, round, warmup: round === 0, n: batch.length, kind: batch.length === 1 ? batch[0].kind : 'mixed', gen_total: gen, wall_ms: wall, agg_tps: wall > 0 ? gen / (wall / 1000) : null, errors: rs.filter(r => r.error).length, rss_mb: await srv.rss.peak() })
    }
  }
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (typeof a.binary !== 'string' || !fs.existsSync(a.binary)) { console.error(`[text-server] --binary missing or not found: ${a.binary || ''}`); process.exit(2) }
  if (typeof a.plan !== 'string') { console.error('[text-server] --plan <file> is required'); process.exit(2) }
  const plan = JSON.parse(fs.readFileSync(a.plan, 'utf8'))
  const job = plan.job
  let srv
  try {
    srv = await startServer(a.binary, plan, job)
  } catch (e) {
    // Record the failed configuration so the report shows it instead of a gap.
    emit('TEXTROW', { ...rowBase(plan, job), warmup: false, error: `start failed: ${e.message.replace(/\s+/g, ' ')}` })
    throw e
  }
  try {
    await runJob(srv, plan, job)
  } finally {
    srv.rss.stop()
    await srv.stop()
  }
}

main().catch(e => { console.error(`[text-server] ${e.stack || e}`); process.exit(1) })
