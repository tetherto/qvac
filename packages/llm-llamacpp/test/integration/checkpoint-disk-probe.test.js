'use strict'

// Dispatch-only probe (not for merge): does `cache_checkpoint_storage: 'disk'`
// load on this device without `cache_checkpoint_dir`? Records the outcome and
// the temp-directory environment; passes either way.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModelPath, safeTest } = require('./utils')

function readEnv(key) {
  if (typeof os.getEnv === 'function') return os.getEnv(key) || ''
  if (typeof process !== 'undefined' && process.env) return process.env[key] || ''
  return ''
}

function probe(t, line) {
  console.log(`[disk-probe] ${line}`)
  t.comment(`[disk-probe] ${line}`)
}

safeTest('checkpoint disk probe: load without cache_checkpoint_dir', { timeout: 600_000 }, async (t) => {
  probe(t, `platform=${os.platform()} arch=${os.arch()}`)
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'TEMPDIR']) {
    probe(t, `env ${key}=${JSON.stringify(readEnv(key))}`)
  }
  let tmp = ''
  try {
    tmp = os.tmpdir()
  } catch (err) {
    probe(t, `os.tmpdir() threw: ${err.message}`)
  }
  probe(t, `os.tmpdir()=${JSON.stringify(tmp)}`)
  if (tmp) {
    const scratch = path.join(tmp, `qvac-disk-probe-${Date.now()}`)
    try {
      fs.mkdirSync(scratch, { recursive: true })
      fs.writeFileSync(path.join(scratch, 'w'), 'x')
      probe(t, 'os.tmpdir() writable=yes')
      fs.rmSync(scratch, { recursive: true, force: true })
    } catch (err) {
      probe(t, `os.tmpdir() writable=no (${err.message})`)
    }
  }

  const modelPath = await ensureModelPath({ modelName: 'Qwen3.5-0.8B-Q8_0.gguf' })
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      ctx_size: '2048',
      n_predict: '16',
      temp: '0',
      cache_checkpoint_storage: 'disk'
    },
    logger: console,
    opts: { stats: true }
  })
  let loaded = false
  try {
    await model.load()
    loaded = true
    probe(t, 'load with disk and no cache_checkpoint_dir: OK')
  } catch (err) {
    probe(t, `load with disk and no cache_checkpoint_dir: FAILED: ${err.message}`)
  }

  if (loaded) {
    // A cached hybrid turn takes a checkpoint on disk; a follow-up uses it.
    const key = path.join(tmp || '.', `qvac-disk-probe-${Date.now()}.bin`)
    const history = [{ role: 'user', content: 'Name one colour of the rainbow.' }]
    try {
      for (let turn = 0; turn < 2; turn++) {
        const response = await model.run(history, {
          cacheKey: key,
          generationParams: { reasoning_budget: 0 }
        })
        let output = ''
        await response.onUpdate((chunk) => { output += chunk }).await()
        probe(t, `turn ${turn + 1}: ok, ${output.length} chars, CacheTokens=${response.stats?.CacheTokens}`)
        history.push({ role: 'assistant', content: output }, { role: 'user', content: 'Another one?' })
      }
    } catch (err) {
      probe(t, `cached turn FAILED: ${err.message}`)
    }
    await model.unload().catch(() => {})
    try {
      fs.rmSync(key, { force: true })
    } catch (_) {}
  }
  t.pass('probe recorded')
})
