'use strict'
/* global Bare */
// Text suite, addon leg (Bare). Runs ONE job of the plan in QVAC_TEXT_PLAN (written
// by run-local.cjs) against @qvac/llm-llamacpp and prints [TEXTROW] / [TEXTBATCH]
// markers; text-server.cjs prints the same markers for llama-server.
//
//   QVAC_TEXT_PLAN=/tmp/plan.json bare benchmarks/vlm-benchmark/text-addon.js

const fs = require('bare-fs')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const W = require('./text-workload.cjs')

const ENGINE = 'addon'

function emit (tag, obj) { console.log(`[${tag}]` + JSON.stringify(obj) + `[/${tag}]`) }

function peakRssMb () {
  try {
    const max = os.resourceUsage().maxRSS
    if (typeof max === 'number' && max > 0) return Math.round(max / 1024)
  } catch (_) {}
  return null
}

// Plan params -> addon config (the same mapping as harness.cjs paramsConfig).
function engineConfig (plan, job) {
  const p = plan.params || {}
  const gpu = plan.backend !== 'cpu'
  const c = {
    device: plan.backend,
    gpu_layers: gpu ? String(p.gpuLayers != null ? p.gpuLayers : 99) : '0',
    temp: '0.0',
    seed: '42',
    ctx_size: String(job.ctx),
    n_predict: String(job.gen || 8),
    parallel: String(job.parallel),
    'reasoning-budget': '0'
  }
  if (job.ignoreEos) c['ignore-eos'] = ''
  if (p.threads != null) c.threads = String(p.threads)
  if (p.batchSize != null) c['batch-size'] = String(p.batchSize)
  if (p.ubatchSize != null) c['ubatch-size'] = String(p.ubatchSize)
  if (p.flashAttn != null) c['flash-attn'] = String(p.flashAttn)
  if (p.cacheTypeK != null) c['cache-type-k'] = String(p.cacheTypeK)
  if (p.cacheTypeV != null) c['cache-type-v'] = String(p.cacheTypeV)
  if (p.fit != null) c.fit = String(p.fit)
  if (p.poll != null) c.poll = String(p.poll)
  if (gpu && p.gpuApi != null) c.backend = String(p.gpuApi)
  // Speculative decoding (addon >= 0.63.0): the same keys as llama-server's flags.
  if (job.spec && job.spec !== 'none') {
    c['spec-type'] = job.spec
    const draft = W.draftModelFor(plan, job)
    if (draft) c['spec-draft-model'] = draft
    if (plan.specDraftNMax != null) c['spec-draft-n-max'] = String(plan.specDraftNMax)
  }
  return c
}

// One request, timed client-side from the run() call (queue wait included, as for
// llama-server's streamed first token).
async function request (model, messages, predict) {
  const t0 = Date.now()
  let first = null
  let last = null
  const parts = []
  const resp = await model.run(messages, { generationParams: { predict } })
  let err = null
  resp.onUpdate(d => { const now = Date.now() - t0; if (first == null) first = now; last = now; parts.push(d) }).onError(e => { err = e })
  await resp.await()
  if (err) throw new Error(String(err))
  const st = resp.stats || {}
  return {
    t0,
    end: Date.now(),
    text: parts.join(''),
    prompt_tokens: st.promptTokens != null ? st.promptTokens : null,
    gen_tokens: st.generatedTokens != null ? st.generatedTokens : null,
    ttft_ms: st.TTFT != null ? st.TTFT : null,
    pp_tps: st.ppTPS != null ? st.ppTPS : null,
    decode_tps: st.TPS != null ? st.TPS : null,
    client_ttft_ms: first,
    client_decode_tps: W.clientDecodeTps(st.generatedTokens, first, last),
    wall_ms: Date.now() - t0,
    stop: st.stopReason || null,
    draft_n: st.draftTokens != null ? st.draftTokens : null,
    draft_accepted: st.draftAcceptedTokens != null ? st.draftAcceptedTokens : null
  }
}

function readCalibration (file) {
  try { return JSON.parse(String(fs.readFileSync(file))) } catch (_) { return null }
}

async function main () {
  const plan = JSON.parse(String(fs.readFileSync(os.getEnv('QVAC_TEXT_PLAN'))))
  const job = plan.job
  const draft = W.draftModelFor(plan, job)
  const base = { engine: ENGINE, backend: plan.backend, model: plan.label, source_ref: plan.sourceRef, job: job.id, suite: job.suite, conc: job.parallel, spec: job.spec || 'none', draft_model: draft ? draft.split(/[\\/]/).pop() : null }

  const model = new LlmLlamacpp({
    files: { model: [plan.llm] },
    config: engineConfig(plan, job),
    logger: { info () {}, debug () {}, warn () {}, error (...a) { console.error('[addon]', ...a) } },
    opts: { stats: true }
  })
  try {
    await model.load()
  } catch (e) {
    // Record the failed configuration so the report shows it instead of a gap.
    let msg = String((e && e.message) || e).replace(/\s+/g, ' ').trim()
    // Hint only on the two rejections an older addon gives; other errors stay as is.
    if (job.spec === 'draft-mtp' && plan.mtpHead && /spec-draft-model requires spec-type/.test(msg)) {
      msg += ' (an external MTP head needs an addon with tetherto/qvac#5232; see LOCAL.md §8)'
    } else if (/invalid argument: --spec-type/.test(msg)) {
      msg += ' (speculative decoding needs @qvac/llm-llamacpp >= 0.63.0)'
    }
    emit('TEXTROW', { ...base, warmup: false, error: `load failed: ${msg}` })
    throw e
  }
  try {
    if (job.suite === 'calibrate') {
      const out = {}
      for (const target of job.targets) {
        const r = await W.calibrate(target, async n => (await request(model, W.messagesFor(n, 0), 1)).prompt_tokens)
        out[target] = r
        console.error(`[text-addon] calibrated ${target} tokens -> ${r.words} words (${r.tokens} tokens)`)
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
          const r = await request(model, W.messagesFor(words, nonce++), job.gen)
          delete r.text
          emit('TEXTROW', { ...base, prompt_target: target, rep, warmup: rep === 0, ...r, t0: undefined, end: undefined, rss_mb: peakRssMb() })
        }
      }
      return
    }

    // conc / spec: rounds of `parallel` concurrent requests; round 0 is warmup.
    const rounds = job.suite === 'conc' ? job.rounds : job.runs
    for (let round = 0; round <= rounds; round++) {
      const reqs = []
      for (let i = 0; i < job.parallel; i++) {
        if (job.suite === 'conc') {
          reqs.push({ kind: 'filler', target: job.prompt, messages: W.messagesFor(wordsFor(job.prompt), nonce++) })
        } else {
          const id = job.prompts[(round * job.parallel + i) % job.prompts.length]
          reqs.push({ kind: id, target: null, messages: [{ role: 'user', content: W.specPrompt(id) }] })
        }
      }
      // spec rounds run every prompt once per round at parallel 1.
      const batches = job.suite === 'spec' && job.parallel === 1
        ? job.prompts.map(id => [{ kind: id, target: null, messages: [{ role: 'user', content: W.specPrompt(id) }] }])
        : [reqs]
      for (const batch of batches) {
        const t0 = Date.now()
        const rs = await Promise.all(batch.map(q => request(model, q.messages, job.gen).catch(e => ({ error: String((e && e.message) || e) }))))
        const wall = Date.now() - t0
        let gen = 0
        rs.forEach((r, i) => {
          if (r.gen_tokens) gen += r.gen_tokens
          const row = { ...base, round, warmup: round === 0, req: i, kind: batch[i].kind, prompt_target: batch[i].target, ...r }
          delete row.t0; delete row.end; delete row.text
          emit('TEXTROW', row)
        })
        emit('TEXTBATCH', { ...base, round, warmup: round === 0, n: batch.length, kind: batch.length === 1 ? batch[0].kind : 'mixed', gen_total: gen, wall_ms: wall, agg_tps: wall > 0 ? gen / (wall / 1000) : null, errors: rs.filter(r => r.error).length, rss_mb: peakRssMb() })
      }
    }
  } finally {
    await model.unload()
  }
}

main().then(() => Bare.exit(0), e => { console.error(`[text-addon] ${e && e.stack ? e.stack : e}`); Bare.exit(1) })
