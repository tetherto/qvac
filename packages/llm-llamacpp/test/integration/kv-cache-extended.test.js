'use strict'

// Opt-in KV-cache suite: user-visible behaviour of conversations kept between
// requests (regenerate, edits, key switches, ephemeral turns, unload, deleted
// or corrupt files, batch concurrency, multimodal and thinking histories,
// overflow, cancel, discardCache, finetune). Every test skips unless
// QVAC_RUN_KV_CACHE_EXTENDED=1; CI never sets it.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, ensureModelPath, getMediaPath, safeTest, setupParams } = require('./utils')

// os.getEnv() is what makes the variable settable on Device Farm.
function readEnv(key) {
  if (typeof os.getEnv === 'function') return os.getEnv(key) || ''
  if (typeof process !== 'undefined' && process.env) return process.env[key] || ''
  return ''
}

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const skipExtended =
  readEnv('QVAC_RUN_KV_CACHE_EXTENDED') === '1'
    ? false
    : 'KV-cache extended suite is opt-in; set QVAC_RUN_KV_CACHE_EXTENDED=1'

const TIMEOUT = 900_000

const QWEN3 = { modelName: 'Qwen3-0.6B-Q8_0.gguf' }
const QWEN35 = { modelName: 'Qwen3.5-0.8B-Q8_0.gguf' }
const QWEN35_MMPROJ = { modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf' }

const BASE_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '4096',
  n_predict: '48',
  temp: '0',
  seed: '7',
  verbosity: '0'
}

const NO_THINK = { generationParams: { reasoning_budget: 0 } }

const SYSTEM = { role: 'system', content: 'You are a concise assistant.' }
const FIRST_TURN = [SYSTEM, { role: 'user', content: 'Name one colour of the rainbow.' }]

function followUp(answer, question, base = FIRST_TURN) {
  return [...base, { role: 'assistant', content: answer }, { role: 'user', content: question }]
}

const toNumber = (value) => (typeof value === 'number' ? value : Number(value || 0))

// What the request found in the cache: everything it holds beyond what this
// request decoded or generated.
function reusedTokens(stats) {
  return (
    toNumber(stats.CacheTokens) - toNumber(stats.promptTokens) - toNumber(stats.generatedTokens)
  )
}

function scratchDir(name) {
  const dir = path.join(os.tmpdir(), `qvac-kv-ext-${name}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_) {}
}

async function loadModel(t, def, config = {}, projection = null) {
  const modelPath = await ensureModelPath(def)
  const files = { model: [modelPath] }
  if (projection) files.projectionModel = await ensureModelPath(projection)
  const model = new LlmLlamacpp({
    files,
    config: { ...BASE_CONFIG, ...config },
    logger: console,
    opts: { stats: true }
  })
  await model.load()
  let unloaded = false
  const unload = async () => {
    if (unloaded) return
    unloaded = true
    await model.unload().catch(() => {})
  }
  t.teardown(unload)
  return { model, unload }
}

async function run(model, messages, runOptions = {}) {
  const response = await model.run(messages, runOptions)
  let output = ''
  await response
    .onUpdate((chunk) => {
      output += chunk
    })
    .await()
  return { output, stats: response.stats || {} }
}

async function coldOutput(t, def, messages, runOptions = {}, config = {}) {
  const { model, unload } = await loadModel(t, def, config)
  const { output } = await run(model, messages, runOptions)
  await unload()
  return output
}

// J1: a regenerate (the same history again) reuses the cache and answers as
// a cold run does.
safeTest(
  'kv-ext: regenerate reuses the cache',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('regenerate')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const { model } = await loadModel(t, QWEN3)

    const first = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
    const again = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })

    t.ok(reusedTokens(again.stats) > 0, `regenerate reused ${reusedTokens(again.stats)} tokens`)
    t.is(again.output, first.output, 'a regenerate answers as the first run did')
  }
)

// J2: editing the last user message on a hybrid model reuses the history with
// two checkpoints, and answers as a cold run either way.
safeTest(
  'kv-ext: hybrid edit of the last user message',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    for (const checkpoints of ['1', '2']) {
      const dir = scratchDir(`edit-${checkpoints}`)
      t.teardown(() => removeDir(dir))
      const key = path.join(dir, 'chat.bin')
      const { model, unload } = await loadModel(t, QWEN35, { cache_checkpoints: checkpoints })

      const first = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
      const second = followUp(first.output, 'Name another.')
      await run(model, second, { ...NO_THINK, cacheKey: key })
      const edited = followUp(first.output, 'Name a warm one.')
      const fromCache = await run(model, edited, { ...NO_THINK, cacheKey: key })
      await unload()

      if (checkpoints === '2') {
        t.ok(
          reusedTokens(fromCache.stats) > 0,
          `the edit reused ${reusedTokens(fromCache.stats)} tokens with two checkpoints`
        )
      }
      t.is(
        fromCache.output,
        await coldOutput(t, QWEN35, edited, NO_THINK, { cache_checkpoints: checkpoints }),
        `cache_checkpoints ${checkpoints}: the edit answers as a cold run`
      )
    }
  }
)

// J3: two keys alternating keep their own histories, with and without the RAM
// tier, and never answer from the other key's cache.
safeTest(
  'kv-ext: alternating keys stay separate',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    for (const ramMib of ['0', '256']) {
      const dir = scratchDir(`alternate-${ramMib}`)
      t.teardown(() => removeDir(dir))
      const keys = { a: path.join(dir, 'a.bin'), b: path.join(dir, 'b.bin') }
      const histories = {
        a: [SYSTEM, { role: 'user', content: 'Name a fruit.' }],
        b: [SYSTEM, { role: 'user', content: 'Name a city.' }]
      }
      const { model, unload } = await loadModel(t, QWEN3, { cache_ram_mib: ramMib })
      for (let turn = 0; turn < 3; turn++) {
        for (const name of ['a', 'b']) {
          const result = await run(model, histories[name], { ...NO_THINK, cacheKey: keys[name] })
          if (turn > 0) {
            t.ok(
              reusedTokens(result.stats) > 0,
              `ram ${ramMib}: key ${name} turn ${turn} reused its history`
            )
          }
          histories[name] = followUp(result.output, 'Another one.', histories[name])
        }
      }
      await unload()
      for (const name of ['a', 'b']) {
        const { model: check, unload: unloadCheck } = await loadModel(t, QWEN3)
        const fromFile = await run(check, histories[name], { ...NO_THINK, cacheKey: keys[name] })
        await unloadCheck()
        t.is(
          fromFile.output,
          await coldOutput(t, QWEN3, histories[name], NO_THINK),
          `ram ${ramMib}: key ${name}'s saved history answers as a cold run`
        )
      }
    }
  }
)

// J4: the ephemeral flag belongs to the conversation's latest request.
safeTest(
  'kv-ext: ephemeral follows the latest request',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('ephemeral')
    t.teardown(() => removeDir(dir))
    const lastEphemeral = path.join(dir, 'last-ephemeral.bin')
    const lastNormal = path.join(dir, 'last-normal.bin')
    const { model, unload } = await loadModel(t, QWEN3)

    const a1 = await run(model, FIRST_TURN, {
      ...NO_THINK,
      cacheKey: lastEphemeral,
      ephemeral: true
    })
    const a2 = await run(model, followUp(a1.output, 'Another.'), {
      ...NO_THINK,
      cacheKey: lastEphemeral
    })
    await run(model, followUp(a2.output, 'One more.', followUp(a1.output, 'Another.')), {
      ...NO_THINK,
      cacheKey: lastEphemeral,
      ephemeral: true
    })

    const b1 = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: lastNormal, ephemeral: true })
    await run(model, followUp(b1.output, 'Another.'), { ...NO_THINK, cacheKey: lastNormal })
    await unload()

    t.absent(
      fs.existsSync(lastEphemeral),
      'a conversation whose last turn was ephemeral is dropped'
    )
    t.ok(fs.existsSync(lastNormal), 'a conversation whose last turn was not ephemeral is written')
  }
)

// J5: unload writes the unsaved turns, and a reload resumes from them.
safeTest(
  'kv-ext: unload then reload resumes',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('unload')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const first = await (async () => {
      const { model, unload } = await loadModel(t, QWEN3)
      const result = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
      t.absent(fs.existsSync(key), 'the turn stays in memory until unload')
      await unload()
      return result
    })()
    t.ok(fs.existsSync(key), 'unload wrote the conversation')

    const { model } = await loadModel(t, QWEN3)
    const next = await run(model, followUp(first.output, 'Name another.'), {
      ...NO_THINK,
      cacheKey: key
    })
    t.ok(
      reusedTokens(next.stats) > 0,
      `the reloaded turn reused ${reusedTokens(next.stats)} tokens`
    )
  }
)

// J6: deleting a written file discards the conversation; nothing rewrites it
// until the next write.
safeTest('kv-ext: deleting a written file', { skip: skipExtended, timeout: TIMEOUT }, async (t) => {
  const dir = scratchDir('deleted')
  t.teardown(() => removeDir(dir))
  const key = path.join(dir, 'chat.bin')
  const { model } = await loadModel(t, QWEN3)

  const first = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
  await model.saveCache(key)
  fs.unlinkSync(key)
  const next = await run(model, followUp(first.output, 'Name another.'), {
    ...NO_THINK,
    cacheKey: key
  })
  t.is(reusedTokens(next.stats), 0, 'the next turn starts cold')
  t.absent(fs.existsSync(key), 'nothing rewrote the deleted file')
})

// J8: benchmark. Logs per-turn timing; asserts only that reuse keeps growing.
safeTest(
  'kv-ext: long session render cost',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('long-session')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const { model } = await loadModel(t, QWEN3, { ctx_size: '16384' })
    const history = [SYSTEM]
    let previous = -1
    for (let turn = 1; turn <= 60; turn++) {
      history.push({ role: 'user', content: `Fact ${turn}: the harbour lamp was checked.` })
      const started = Date.now()
      const { stats } = await run(model, history, { ...NO_THINK, cacheKey: key, prefill: true })
      const cached = toNumber(stats.CacheTokens)
      t.ok(cached > previous, `turn ${turn}: cache grew to ${cached}`)
      previous = cached
      if (turn === 1 || turn % 10 === 0) {
        t.comment(`[render-cost] turn=${turn} cache=${cached} ms=${Date.now() - started}`)
      }
      history.push({ role: 'assistant', content: 'Noted.' })
    }
  }
)

// J9: two concurrent requests on one key both complete; the second waits for
// the first.
safeTest(
  'kv-ext: concurrent requests on one key',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('same-key')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const { model } = await loadModel(t, QWEN3, { parallel: '2' })

    const results = await Promise.all([
      run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key }),
      run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
    ])
    t.ok(
      results.every((r) => r.output.length > 0),
      'both requests complete'
    )
    await model.saveCache(key)
    t.ok(fs.existsSync(key), 'the key holds a committed conversation')
  }
)

// J10: saveCache with a request on the key still queued resolves, and its
// file loads.
safeTest(
  'kv-ext: saveCache beside a queued request',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('save-queued')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    let answer = ''
    {
      const { model, unload } = await loadModel(t, QWEN3, { parallel: '2' })
      answer = (await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })).output
      const queued = run(model, followUp(answer, 'Name another.'), { ...NO_THINK, cacheKey: key })
      await model.saveCache(key)
      await queued
      await unload()
    }
    const { model } = await loadModel(t, QWEN3, { parallel: '2' })
    const next = await run(model, followUp(answer, 'Name a third.'), { ...NO_THINK, cacheKey: key })
    t.ok(next.output.length > 0, 'the saved file loads on a fresh model')
  }
)

// J11: an image turn is reused by a text follow-up and by the same image sent
// again, not by a different image.
safeTest('kv-ext: multimodal reuse', { skip: skipExtended, timeout: TIMEOUT }, async (t) => {
  const dir = scratchDir('multimodal')
  t.teardown(() => removeDir(dir))
  const { model } = await loadModel(t, QWEN35, { ctx_size: '8192' }, QWEN35_MMPROJ)
  const fruit = fs.readFileSync(getMediaPath('fruitPlate.png'))
  const elephant = fs.readFileSync(getMediaPath('elephant.jpg'))
  const withImage = (image) => [
    SYSTEM,
    { role: 'user', type: 'media', content: image },
    { role: 'user', content: 'Describe the image in one sentence.' }
  ]

  const key = path.join(dir, 'chat.bin')
  const first = await run(model, withImage(fruit), { ...NO_THINK, cacheKey: key })
  const text = await run(
    model,
    followUp(first.output, 'Name one object in it.', withImage(fruit)),
    {
      ...NO_THINK,
      cacheKey: key
    }
  )
  t.ok(reusedTokens(text.stats) > 0, `the text follow-up reused ${reusedTokens(text.stats)}`)

  const sameKey = path.join(dir, 'same.bin')
  await run(model, withImage(fruit), { ...NO_THINK, cacheKey: sameKey })
  const same = await run(model, withImage(fruit), { ...NO_THINK, cacheKey: sameKey })
  const otherKey = path.join(dir, 'other.bin')
  await run(model, withImage(fruit), { ...NO_THINK, cacheKey: otherKey })
  const other = await run(model, withImage(elephant), { ...NO_THINK, cacheKey: otherKey })
  t.ok(
    reusedTokens(same.stats) > reusedTokens(other.stats),
    `the same image reused ${reusedTokens(same.stats)}, a different one ${reusedTokens(other.stats)}`
  )
})

// J12: a thinking model's history, sent with its reasoning omitted, kept or
// split into reasoning_content, answers as a cold run, with balanced tags.
safeTest(
  'kv-ext: thinking history variants',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('thinking')
    t.teardown(() => removeDir(dir))
    const config = { n_predict: '512' }
    const { model, unload } = await loadModel(t, QWEN3, config)
    const first = await run(model, FIRST_TURN, { cacheKey: path.join(dir, 'seed.bin') })
    await unload()
    const raw = first.output
    const close = raw.indexOf('</think>')
    t.ok(close > 0, 'the first answer has a reasoning block')
    const reasoning = raw.slice(raw.indexOf('<think>') + '<think>'.length, close).trim()
    const answer = raw.slice(close + '</think>'.length).trim()

    const variants = {
      omitted: followUp(answer, 'Name another.'),
      kept: followUp(raw, 'Name another.'),
      split: [
        ...FIRST_TURN,
        { role: 'assistant', content: answer, reasoning_content: reasoning },
        { role: 'user', content: 'Name another.' }
      ]
    }
    for (const [name, history] of Object.entries(variants)) {
      const key = path.join(dir, `${name}.bin`)
      const { model: cached, unload: unloadCached } = await loadModel(t, QWEN3, config)
      await run(cached, FIRST_TURN, { cacheKey: key })
      const fromCache = await run(cached, history, { cacheKey: key })
      await unloadCached()
      const opens = fromCache.output.split('<think>').length - 1
      const closes = fromCache.output.split('</think>').length - 1
      t.is(opens, closes, `${name}: reasoning tags are balanced`)
      t.is(
        fromCache.output,
        await coldOutput(t, QWEN3, history, {}, config),
        `${name}: as a cold run`
      )
    }
  }
)

// J13: a turn that overflows the window rolls back; the next short turn still
// reuses the history before it, on both paths.
safeTest(
  'kv-ext: overflow then a short turn',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    for (const parallel of ['1', '2']) {
      const dir = scratchDir(`overflow-${parallel}`)
      t.teardown(() => removeDir(dir))
      const key = path.join(dir, 'chat.bin')
      const ctx = parallel === '1' ? '512' : '1024'
      const { model, unload } = await loadModel(t, QWEN3, { ctx_size: ctx, parallel })

      const first = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
      let overflowed = false
      try {
        const long = await run(model, followUp(first.output, 'Tell me a long story.'), {
          cacheKey: key,
          generationParams: {
            reasoning_budget: 0,
            predict: -1,
            grammar: 'root ::= "lighthouse " root'
          }
        })
        overflowed = long.stats.stopReason === 'contextOverflow'
      } catch (err) {
        overflowed = /overflow|context/i.test(err.message)
      }
      t.ok(overflowed, `parallel ${parallel}: the long turn overflowed the window`)

      const next = await run(model, followUp(first.output, 'Name another.'), {
        ...NO_THINK,
        cacheKey: key
      })
      t.ok(
        reusedTokens(next.stats) > 0,
        `parallel ${parallel}: the short turn reused ${reusedTokens(next.stats)} tokens`
      )
      await unload()
    }
  }
)

// J14: a cancel during generation keeps what was streamed; the follow-up that
// includes it reuses it.
safeTest(
  'kv-ext: cancel during generation',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('cancel')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const { model } = await loadModel(t, QWEN3, { n_predict: '256' })
    const prompt = [SYSTEM, { role: 'user', content: 'Count from one to fifty in words.' }]

    const response = await model.run(prompt, { ...NO_THINK, cacheKey: key })
    let partial = ''
    let chunks = 0
    try {
      await response
        .onUpdate(async (chunk) => {
          partial += chunk
          if (++chunks === 12) await response.cancel()
        })
        .await()
    } catch (_) {}
    t.ok(chunks >= 12, 'generation reached the cancel point')

    const next = await run(model, followUp(partial, 'Continue.', prompt), {
      ...NO_THINK,
      cacheKey: key
    })
    t.ok(
      reusedTokens(next.stats) > 0,
      `the follow-up reused ${reusedTokens(next.stats)} tokens including the partial answer`
    )
  }
)

// J15: a file written at a larger context loads cleanly into a smaller one or
// is refused with an error, never a crash.
safeTest(
  'kv-ext: file from a larger context',
  { skip: skipExtended, timeout: TIMEOUT },
  async (t) => {
    const dir = scratchDir('larger-ctx')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const long = [
      SYSTEM,
      { role: 'user', content: `Remember these words: ${'lighthouse harbour lamp '.repeat(200)}` }
    ]
    {
      const { model, unload } = await loadModel(t, QWEN3, { ctx_size: '4096' })
      await run(model, long, { cacheKey: key, prefill: true })
      await model.saveCache(key)
      await unload()
    }
    const { model } = await loadModel(t, QWEN3, { ctx_size: '512' })
    try {
      const result = await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
      t.ok(result.output.length > 0, 'the smaller context answered')
    } catch (err) {
      t.ok(err instanceof Error, `the smaller context refused the file: ${err.message}`)
    }
  }
)

// J16: discardCache drops a conversation that was never written, on both
// paths, so unload does not write it.
safeTest('kv-ext: discardCache', { skip: skipExtended, timeout: TIMEOUT }, async (t) => {
  for (const parallel of ['1', '2']) {
    const dir = scratchDir(`discard-${parallel}`)
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const { model, unload } = await loadModel(t, QWEN3, { parallel })
    await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })
    await model.discardCache(key)
    await t.exception(model.saveCache(key), /no conversation is cached/)
    await unload()
    t.absent(fs.existsSync(key), `parallel ${parallel}: unload wrote a discarded conversation`)
  }
})

// J17: starting a finetune does not write an ephemeral conversation.
safeTest(
  'kv-ext: finetune keeps an ephemeral conversation off disk',
  { skip: skipExtended || useCpu, timeout: TIMEOUT },
  async (t) => {
    const [modelName, modelDir] = await ensureModel(QWEN3)
    const dir = scratchDir('finetune-ephemeral')
    t.teardown(() => removeDir(dir))
    const key = path.join(dir, 'chat.bin')
    const { model } = await loadModel(t, QWEN3, { ctx_size: '512' })
    await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key, ephemeral: true })

    const params = setupParams(modelDir, { testId: 'kv-ext-ephemeral', datasetSize: 8 })
    t.teardown(() => {
      removeDir(params.checkpointSaveDir)
      removeDir(params.outputParametersDir)
    })
    const handle = await model.finetune(params)
    await model.cancel()
    await handle.await().catch(() => {})
    t.comment(`finetuned ${modelName}`)
    t.absent(fs.existsSync(key), 'starting a finetune wrote an ephemeral conversation')
  }
)

// J7: a corrupt file fails the turn with a load error or is ignored, never
// crashes; deleting it recovers. Last in the file: a truncated file currently
// aborts the process in fabric's `llama_state_seq_load_file`
// (`GGML_ASSERT(nread <= state_size)`), which ends the run.
safeTest('kv-ext: corrupt cache file', { skip: skipExtended, timeout: TIMEOUT }, async (t) => {
  const dir = scratchDir('corrupt')
  t.teardown(() => removeDir(dir))
  const key = path.join(dir, 'chat.bin')
  let answer = ''
  {
    const { model, unload } = await loadModel(t, QWEN3)
    answer = (await run(model, FIRST_TURN, { ...NO_THINK, cacheKey: key })).output
    await model.saveCache(key)
    await unload()
  }
  const bytes = fs.readFileSync(key)
  fs.writeFileSync(key, bytes.subarray(0, Math.floor(bytes.length / 2)))

  const { model } = await loadModel(t, QWEN3)
  const history = followUp(answer, 'Name another.')
  try {
    const result = await run(model, history, { ...NO_THINK, cacheKey: key })
    t.is(reusedTokens(result.stats), 0, 'a truncated file is not reused')
  } catch (err) {
    t.ok(/load|cache/i.test(err.message), `a truncated file is reported: ${err.message}`)
  }
  fs.unlinkSync(key)
  const recovered = await run(model, history, { ...NO_THINK, cacheKey: key })
  t.ok(recovered.output.length > 0, 'the key works again once the file is deleted')
})
