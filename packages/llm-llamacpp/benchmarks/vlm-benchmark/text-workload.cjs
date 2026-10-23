'use strict'
// Text workload shared by the addon (Bare, text-addon.js) and llama-server (Node,
// text-server.cjs) legs of the text suite: deterministic filler prompts, prompt-length
// calibration, the speculative-decoding prompts, presets and the job plan.
// No requires: this file must load unchanged under both runtimes.

// Filler vocabulary: common English words so the tokenizer sees ordinary prose.
const WORDS = (
  'the of and to in is that for it as was with be by on not he this are or his from at ' +
  'which but have an they you were her she there been one all we their has would when ' +
  'what will more if no out so said can who about them other into than its time only ' +
  'could new these two may first then do any like my now over such our man me even most ' +
  'made after also did many before must through back years where much your way well down ' +
  'should because each just those people how too little state good very make world still ' +
  'own see men work long get here between both life being under never day same another ' +
  'know while last might us great old year off come since against go came right used take ' +
  'three small large city water house light river market garden window letter morning ' +
  'question reason number system program report table value result method paper school'
).split(' ')

// mulberry32: small seeded PRNG, so every run and engine gets the same filler text.
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fillerCache = new Map()
function filler (nWords) {
  if (!fillerCache.has(nWords)) {
    const r = rng(1234)
    const out = []
    for (let i = 0; i < nWords; i++) {
      out.push(WORDS[Math.floor(r() * WORDS.length)])
      if (i % 14 === 13) out[out.length - 1] += '.'
    }
    fillerCache.set(nWords, out.join(' '))
  }
  return fillerCache.get(nWords)
}

// One user message of `nWords` filler words. The fixed-width nonce makes every request
// unique (no prompt-cache hits) without changing its token count.
function promptFor (nWords, nonce) {
  return `Document ${String(nonce).padStart(6, '0')}.\n${filler(nWords)}\n\nSummarize the document above.`
}

function messagesFor (nWords, nonce) {
  return [{ role: 'user', content: promptFor(nWords, nonce) }]
}

// Find the filler length whose rendered chat prompt is `target` tokens.
// `measure(nWords)` -> prompt tokens as the engine counts them (template included).
async function calibrate (target, measure) {
  let n = Math.max(8, Math.round(target * 0.7))
  let best = null
  for (let i = 0; i < 12; i++) {
    const t = await measure(n)
    if (best == null || Math.abs(t - target) < Math.abs(best.tokens - target)) best = { words: n, tokens: t }
    if (t === target) break
    const perWord = Math.max(0.5, t / n)
    const step = Math.round((target - t) / perWord)
    n = Math.max(1, n + (step === 0 ? Math.sign(target - t) : step))
  }
  return best
}

// Speculative-decoding prompts: one each of code, rewrite, story and explain, so
// draft acceptance covers copy-heavy and free-form output.
const SPEC_PROMPTS = [
  {
    id: 'code',
    prompt: 'Write a Python module that implements a least-recently-used cache class with get, put and delete methods, ' +
      'type hints, docstrings and a small set of unit tests using unittest.'
  },
  {
    id: 'rewrite',
    prompt: 'Rewrite the following paragraph in a formal tone, keeping every fact:\n\n' +
      'So the team got together last week and basically decided the old billing system had to go. It was slow, it broke ' +
      'every time we added a new currency, and honestly nobody understood the code anymore. The plan is to move ' +
      'everything to the new service by March, run both systems side by side for a month, and then switch off the old ' +
      'one. Sarah is leading the migration, Tom is handling the data checks, and the support team will get training in ' +
      'February so they can answer customer questions about the new invoices.'
  },
  {
    id: 'story',
    prompt: 'Write a short story about a lighthouse keeper who finds a message in a bottle that was written by her ' +
      'grandmother fifty years ago.'
  },
  {
    id: 'explain',
    prompt: 'Explain how a hash map works, including hashing, collisions, load factor and resizing, for a reader who ' +
      'knows basic programming but not data structures.'
  }
]

// Run shapes. quick = a wiring check; standard follows the usual engine-comparison
// matrix (p512/p2048 x n128, concurrency sweep, speculative prompts x 2).
const TEXT_PRESETS = {
  quick: {
    single: { prompts: [512], gen: 64, repeats: 1 },
    conc: { levels: [1, 4], prompt: 512, gen: 64, rounds: 1 },
    spec: { gen: 256, runs: 1, levels: [1], prompts: ['code', 'rewrite'] }
  },
  standard: {
    single: { prompts: [512, 2048], gen: 128, repeats: 3 },
    conc: { levels: [1, 2, 4, 8, 16], prompt: 512, gen: 128, rounds: 2 },
    spec: { gen: 512, runs: 2, levels: [1], prompts: SPEC_PROMPTS.map(p => p.id) }
  },
  full: {
    single: { prompts: [128, 512, 2048, 4096], gen: 128, repeats: 3 },
    conc: { levels: [1, 2, 4, 8, 16, 32], prompt: 512, gen: 128, rounds: 3 },
    spec: { gen: 512, runs: 2, levels: [1, 4, 8], prompts: SPEC_PROMPTS.map(p => p.id) }
  }
}

const SUITES = ['single', 'conc', 'spec']
// llama-server --spec-type values (qvac-fabric common/speculative.cpp).
const SPEC_TYPES = ['ngram-simple', 'ngram-map-k', 'ngram-mod', 'ngram-cache', 'draft-simple', 'draft-mtp', 'draft-dflash', 'draft-dspark']
// The addon's `spec-type` values (llm-llamacpp >= 0.63.0); the others run on llama-server only.
const ADDON_SPEC_TYPES = ['draft-mtp', 'draft-dflash']
// Speculative modes that load a separate draft model (--draft).
const DRAFT_MODEL_SPEC_TYPES = ['draft-simple', 'draft-dflash', 'draft-dspark']

// The extra model a speculative job loads, if any: the --draft model, or for
// draft-mtp an external MTP head (--mtp-head; addon: tetherto/qvac#5232). Both
// engines take it the same way: addon `spec-draft-model`, llama-server `-md`.
function draftModelFor (plan, job) {
  if (!job.spec || job.spec === 'none') return null
  if (DRAFT_MODEL_SPEC_TYPES.includes(job.spec)) return plan.draft || null
  if (job.spec === 'draft-mtp') return plan.mtpHead || null
  return null
}
// Upper bound on a speculative prompt's rendered length, for slot sizing.
const SPEC_PROMPT_MAX_TOKENS = 256

// Per-slot context: prompt + generation + template/rounding headroom, in 256s.
function slotCtx (promptTokens, gen) {
  return Math.ceil((promptTokens + gen + 64) / 256) * 256
}

// Jobs, in run order. Each job is one model load (addon process / server start).
// Speculative modes outside ADDON_SPEC_TYPES run on llama-server only.
function buildJobs (shape, suites, specTypes) {
  const jobs = []
  const targets = new Set()
  if (suites.includes('single')) shape.single.prompts.forEach(p => targets.add(p))
  if (suites.includes('conc')) targets.add(shape.conc.prompt)
  if (targets.size) {
    const maxT = Math.max(...targets)
    jobs.push({ id: 'calibrate', suite: 'calibrate', parallel: 1, ctx: slotCtx(maxT, 8), targets: [...targets].sort((x, y) => x - y) })
  }
  // One single-stream job per prompt length, so the engine order alternates across them.
  if (suites.includes('single')) {
    const s = shape.single
    for (const p of s.prompts) {
      jobs.push({ id: `single-${p}`, suite: 'single', parallel: 1, ctx: slotCtx(p, s.gen), ignoreEos: true, gen: s.gen, prompts: [p], repeats: s.repeats })
    }
  }
  if (suites.includes('conc')) {
    const c = shape.conc
    for (const n of c.levels) {
      jobs.push({ id: `conc-${n}`, suite: 'conc', parallel: n, ctx: n * slotCtx(c.prompt, c.gen), ignoreEos: true, gen: c.gen, prompt: c.prompt, rounds: c.rounds })
    }
  }
  if (suites.includes('spec')) {
    const s = shape.spec
    for (const spec of specTypes) {
      for (const n of s.levels) {
        jobs.push({ id: `spec-${spec}-${n}`, suite: 'spec', spec, parallel: n, ctx: n * slotCtx(SPEC_PROMPT_MAX_TOKENS, s.gen), ignoreEos: false, gen: s.gen, prompts: s.prompts, runs: s.runs, serverOnly: spec !== 'none' && !ADDON_SPEC_TYPES.includes(spec) })
      }
    }
  }
  return jobs
}

function specPrompt (id) {
  const p = SPEC_PROMPTS.find(x => x.id === id)
  if (!p) throw new Error(`unknown speculative prompt '${id}'`)
  return p.prompt
}

// Per-request decode rate from client-side timestamps: tokens after the first
// over the time between the first and last streamed token.
function clientDecodeTps (genTokens, firstMs, lastMs) {
  if (genTokens == null || genTokens < 2 || firstMs == null || lastMs == null || lastMs <= firstMs) return null
  return (genTokens - 1) / ((lastMs - firstMs) / 1000)
}

module.exports = {
  promptFor,
  messagesFor,
  calibrate,
  SPEC_PROMPTS,
  specPrompt,
  TEXT_PRESETS,
  SUITES,
  SPEC_TYPES,
  ADDON_SPEC_TYPES,
  DRAFT_MODEL_SPEC_TYPES,
  draftModelFor,
  buildJobs,
  slotCtx,
  clientDecodeTps
}
