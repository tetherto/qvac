'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { performance } = require('perf_hooks')
const { settings, question } = require('./video-config.cjs')
const RESPONSE_MARKER = 'VIDEO_E2E_RESPONSE_BEGIN'

function responseText(stdout) {
  const index = stdout.indexOf(RESPONSE_MARKER)
  return index < 0 ? '' : stdout.slice(index + RESPONSE_MARKER.length).trim()
}

// Preserve the model-provided template, changing only its documented thinking switch.
function templateFromGguf(file) {
  const fd = fs.openSync(file, 'r')
  let offset = 0
  function read(n) {
    const b = Buffer.alloc(n)
    fs.readSync(fd, b, 0, n, offset)
    offset += n
    return b
  }
  function u32() {
    return read(4).readUInt32LE()
  }
  function u64() {
    return Number(read(8).readBigUInt64LE())
  }
  function str() {
    return read(u64()).toString('utf8')
  }
  function value(type) {
    if (type === 8) return str()
    if (type === 9) {
      const t = u32()
      const n = u64()
      for (let i = 0; i < n; i++) value(t)
      return
    }
    const lengths = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
    if (!lengths[type]) throw new Error('unknown GGUF value type ' + type)
    read(lengths[type])
  }
  try {
    if (read(4).toString() !== 'GGUF') throw new Error('not GGUF')
    u32()
    u64()
    const count = u64()
    for (let i = 0; i < count; i++) {
      const key = str()
      const type = u32()
      const v = value(type)
      if (key === 'tokenizer.chat_template') return '{% set enable_thinking = false %}\n' + v
    }
    throw new Error('no chat template')
  } finally {
    fs.closeSync(fd)
  }
}

function metrics(stderr) {
  const sum = (pattern) => [...stderr.matchAll(pattern)].reduce((n, m) => n + Number(m[1]), 0)
  const prompt = stderr.match(/prompt eval time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens/)
  const generation = stderr.match(/(?<!prompt )eval time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) runs/)
  const load = stderr.match(/load time\s*=\s*([\d.]+) ms/)
  const vision = sum(/mtmd batch encoding done in ([\d.]+) ms/g)
  return {
    visionEncodeMs: vision,
    promptEvalMs: prompt ? +prompt[1] : null,
    promptTokens: prompt ? +prompt[2] : null,
    generationEvalMs: generation ? +generation[1] : null,
    generationEvalRuns: generation ? +generation[2] : null,
    engineLoadMs: load ? +load[1] : null
  }
}

async function runCase(config, cell) {
  const paths = cell.paths
  const timestamps = cell.timestampsS || paths.map((_, i) => i)
  let prompt =
    paths
      .map((_, i) => `[Frame ${i + 1}, ${timestamps[i].toFixed(3)} seconds] <__media__>\n`)
      .join('') + question
  if (cell.textWords) {
    prompt = 'This is background context. '.repeat(Math.ceil(cell.textWords / 5)) + '\n' + prompt
  }
  const args = [
    '-m',
    config.model,
    '--mmproj',
    config.projector,
    '--image',
    paths.join(','),
    '-p',
    prompt,
    '-n',
    String(settings.predictionTokens),
    '-c',
    String(cell.context || settings.context),
    '-ub',
    '320',
    '-t',
    '6',
    '-ngl',
    'all',
    '--device',
    'Vulkan1',
    '--mmproj-device',
    'Vulkan1',
    '--image-max-tokens',
    String(settings.imageMaxTokens),
    '--temp',
    '0',
    '--seed',
    '42',
    '--jinja',
    '--chat-template',
    templateFromGguf(config.model),
    '--perf',
    '--log-timestamps',
    '--no-warmup',
    '--verbosity',
    '4',
    '-fit',
    'off'
  ]
  const start = performance.now()
  let stdout = '',
    stderr = '',
    firstOutputMs = null,
    readyMs = null
  const child = spawn(config.binary, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MTMD_TEST_RESPONSE_MARKER: RESPONSE_MARKER }
  })
  const timed = []
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 300000)
  child.stdout.on('data', (chunk) => {
    const elapsed = performance.now() - start
    const text = chunk.toString()
    stdout += text
    if (firstOutputMs === null && responseText(stdout)) {
      firstOutputMs = elapsed
    }
    timed.push({ stream: 'stdout', ms: elapsed, text })
  })
  child.stderr.on('data', (chunk) => {
    const elapsed = performance.now() - start
    const text = chunk.toString()
    stderr += text
    if (readyMs === null && stderr.includes('main: loading model:')) readyMs = elapsed
    timed.push({ stream: 'stderr', ms: elapsed, text })
  })
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  clearTimeout(timeout)
  const wallMs = performance.now() - start
  const m = metrics(stderr)
  const result = {
    id: cell.id,
    model: config.id,
    source: 'upstream llama-mtmd-cli b10796 / Vulkan RTX4050',
    frames: paths.length,
    context: cell.context || settings.context,
    textWords: cell.textWords || 0,
    code,
    timedOut,
    wallMs,
    modelReadyMs: readyMs,
    firstOutputMs,
    ...m,
    warmedOsCache: true,
    modelReloadedEachCase: true,
    nativeTemporalPairing: false,
    preprocessing: cell.preprocessing || null,
    output: responseText(stdout)
  }
  result.e2eColdMs = wallMs + (cell.preprocessing?.preprocessingMs || 0)
  result.e2eWithoutLoadMs = readyMs === null ? null : result.e2eColdMs - readyMs
  fs.writeFileSync(path.join(config.output, cell.id + '.log'), stderr + '\nSTDOUT:\n' + stdout)
  fs.writeFileSync(path.join(config.output, cell.id + '.timed.json'), JSON.stringify(timed))
  fs.writeFileSync(path.join(config.output, cell.id + '.json'), JSON.stringify(result, null, 2))
  console.log('[VIDEO-CLI] ' + JSON.stringify(result))
  if (code !== 0 || m.promptEvalMs === null || m.generationEvalMs === null || !result.output) {
    throw new Error('invalid benchmark cell ' + cell.id)
  }
  return result
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  fs.mkdirSync(config.output, { recursive: true })
  for (const cell of config.cells) {
    if (fs.existsSync(path.join(config.output, cell.id + '.json'))) continue
    await runCase(config, cell)
  }
}

module.exports = { templateFromGguf, metrics, runCase, responseText }
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
