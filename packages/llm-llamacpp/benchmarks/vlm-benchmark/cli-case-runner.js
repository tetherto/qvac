#!/usr/bin/env node
'use strict'

// VENDORED into this benchmark folder (with accuracy.js / stdout-parser.js / utils.js /
// cli-source-config.js / build-cli-sources.js) so the VLM benchmark is self-contained
// and does not import from the separate vlm-performance sub-project.
//
// CLI-based case runner (plain Node.js — NOT Bare).
//
// Same contract as case-runner.js but drives inference through a native
// llama-mtmd-cli binary instead of the JS addon. Used for the fabric
// and upstream legs of the 3-source comparison.
//
// Inputs via env (matching case-runner.js):
//   VLM_CASE_SPEC_PATH  — JSON with CaseSpec (see below)
//   VLM_RESULT_PATH     — where to write per-cell JSON
//
// CaseSpec additions for CLI mode:
//   cliBinaryPath       — absolute path to llama-mtmd-cli

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const { scoreAnswer } = require('./accuracy')
const { parseStdoutMetrics } = require('./stdout-parser')
const { truncate } = require('./utils')

function readSpec (specPath) {
  return JSON.parse(fs.readFileSync(specPath, 'utf8'))
}

function sleep (ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* busy-wait — no async in this runner */ }
}

// Extract the chat template from a GGUF file using pure Node.js.
// GGUF format: magic(4) + version(u32) + tensorCount(u64) + kvCount(u64)
// then kvCount key-value pairs. We scan for the "tokenizer.chat_template" key.
let _cachedPatchedTemplate = null

const GGUF_VALUE_TYPE_STRING = 8

function readGgufChatTemplate (ggufPath) {
  const fd = fs.openSync(ggufPath, 'r')
  try {
    const headerBuf = Buffer.alloc(24)
    fs.readSync(fd, headerBuf, 0, 24, 0)
    const magic = headerBuf.toString('ascii', 0, 4)
    if (magic !== 'GGUF') return null
    const version = headerBuf.readUInt32LE(4)
    if (version < 2) return null
    const kvCount = Number(headerBuf.readBigUInt64LE(16))

    let offset = 24
    const read = (len) => {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, offset)
      offset += len
      return buf
    }
    const readU32 = () => { const b = read(4); return b.readUInt32LE(0) }
    const readU64 = () => { const b = read(8); return Number(b.readBigUInt64LE(0)) }
    const readStr = () => { const len = readU64(); const b = read(len); return b.toString('utf8') }
    const skipValue = (type) => {
      switch (type) {
        case 0: read(1); break // u8
        case 1: read(1); break // i8
        case 2: read(2); break // u16
        case 3: read(2); break // i16
        case 4: read(4); break // u32
        case 5: read(4); break // i32
        case 6: read(4); break // f32
        case 7: read(1); break // bool
        case 8: readStr(); break // string
        case 9: { // array
          const arrType = readU32()
          const arrLen = readU64()
          for (let j = 0; j < arrLen; j++) skipValue(arrType)
          break
        }
        case 10: read(8); break // u64
        case 11: read(8); break // i64
        case 12: read(8); break // f64
        default: throw new Error(`unknown GGUF value type ${type}`)
      }
    }

    for (let i = 0; i < kvCount; i++) {
      const key = readStr()
      const valType = readU32()
      if (key === 'tokenizer.chat_template' && valType === GGUF_VALUE_TYPE_STRING) {
        return readStr()
      }
      skipValue(valType)
    }
  } finally {
    fs.closeSync(fd)
  }
  return null
}

function getPatchedTemplate (ggufPath, thinkingEnabled) {
  const cacheKey = thinkingEnabled ? 'on' : 'off'
  if (_cachedPatchedTemplate && _cachedPatchedTemplate._key === cacheKey) return _cachedPatchedTemplate.value
  try {
    const raw = readGgufChatTemplate(ggufPath)
    if (!raw || !raw.includes('{%')) return null
    const patched = raw.replace(
      'enable_thinking is defined and enable_thinking is true',
      thinkingEnabled ? 'true' : 'false'
    )
    _cachedPatchedTemplate = { _key: cacheKey, value: patched }
    return patched
  } catch (e) {
    console.error(`[cli-case-runner] template extraction failed: ${e.message}`)
    return null
  }
}

function buildCliArgs (spec) {
  const args = [
    '--model', spec.llmPath,
    '--mmproj', spec.mmprojPath,
    '--image', spec.imagePath,
    '--ctx-size', String(spec.ctxSize),
    '--predict', String(spec.nPredict),
    '--gpu-layers', spec.backend === 'cpu' ? '0' : '99',
    '--threads', String(os.cpus().length),
    '--temp', String(spec.temperature ?? 0),
    '--seed', String(spec.seed ?? 42),
    '--jinja'
  ]

  // Control reasoning mode. The fabric fork injects enable_thinking=true
  // by default, but upstream doesn't — it defaults to the empty-think
  // path. To ensure consistent behavior across sources, always patch
  // the model's chat template to explicitly set the thinking mode.
  const patched = getPatchedTemplate(spec.llmPath, spec.thinkingEnabled)
  if (patched) {
    args.push('--chat-template', patched)
  }

  // NOTE: `--verbose-prompt` (a prompt dump for parity audits) was removed — llama.cpp
  // dropped the flag around build 8828 ("error: invalid argument: --verbose-prompt"),
  // which made the CLIs fail outright at the auto-resolved build. Nothing in the pipeline
  // parses its output (metrics come from the timing lines, not the prompt dump), so it is
  // simply gone rather than gated on a build check.

  args.push('-p', spec.prompt)

  return args
}

function stripAnsi (s) {
  let out = ''
  let inEsc = false
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x1b) { inEsc = true; continue }
    if (inEsc) { if (s[i] === 'm') inEsc = false; continue }
    out += s[i]
  }
  return out
}

function extractGeneratedText (stdout) {
  if (!stdout) return ''
  return stripAnsi(stdout).trim()
}

function parseMaxRssFromTimeV (stderr) {
  // GNU /usr/bin/time -v outputs "Maximum resident set size (kbytes): NNN"
  const match = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)
  if (match) return Number(match[1]) / 1024
  return null
}

function runOnceCli (spec) {
  const args = buildCliArgs(spec)
  const timeout = spec.perRunTimeoutMs || 5 * 60 * 1000

  // On Linux, wrap with /usr/bin/time -v to capture peak RSS.
  // On other platforms, skip RSS collection (no portable equivalent).
  const useTimeWrapper = os.platform() === 'linux' && fs.existsSync('/usr/bin/time')
  const spawnCmd = useTimeWrapper ? '/usr/bin/time' : spec.cliBinaryPath
  const spawnArgs = useTimeWrapper
    ? ['-v', spec.cliBinaryPath, ...args]
    : args

  const t0 = Date.now()
  const result = spawnSync(spawnCmd, spawnArgs, {
    encoding: 'utf8',
    timeout,
    env: { ...process.env },
    cwd: path.dirname(spec.cliBinaryPath)
  })
  const wallMs = Date.now() - t0

  if (result.error) {
    throw new Error(`CLI spawn failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    // Surface the ACTUAL llama/mtmd failure, not just the trailing `/usr/bin/time -v`
    // resource summary (~23 lines) that the wrapper appends. Pull any error-looking lines
    // plus a generous tail so the real cause (load/flag/assert error) is visible.
    const lines = (result.stderr || '').trim().split('\n')
    const errish = lines.filter(l => /error|fail|assert|unknown|unrecognized|invalid|unsupported|terminate|what\(\)|GGML_|exception|cannot|no such/i.test(l))
    const tail = [...new Set([...errish, ...lines.slice(-25)])].join('\n')
    throw new Error(`CLI exited with status ${result.status}:\n${tail}`)
  }

  const text = extractGeneratedText(result.stdout)
  const stderr = result.stderr || ''
  const peakRssMb = useTimeWrapper ? parseMaxRssFromTimeV(stderr) : null

  return { text, wallMs, stderr, peakRssMb }
}

function main () {
  const specPath = process.env.VLM_CASE_SPEC_PATH
  const resultPath = process.env.VLM_RESULT_PATH
  if (!specPath || !resultPath) {
    console.error('VLM_CASE_SPEC_PATH and VLM_RESULT_PATH env vars are required')
    process.exit(2)
  }

  const spec = readSpec(specPath)

  if (!spec.cliBinaryPath || !fs.existsSync(spec.cliBinaryPath)) {
    console.error(`CLI binary not found: ${spec.cliBinaryPath}`)
    process.exit(2)
  }

  const cellStartedAt = new Date().toISOString()
  const errors = []
  const runs = []

  // Warmup runs
  for (let i = 0; i < (spec.warmupRuns || 0); i++) {
    console.error(`[BENCH_RUN_BEGIN warmup ${i}]`)
    try {
      runOnceCli(spec)
    } catch (e) {
      errors.push({ phase: 'warmup', index: i, message: String((e && e.message) || e) })
    }
    console.error(`[BENCH_RUN_END warmup ${i}]`)
    if (spec.cooldownMs) sleep(spec.cooldownMs)
  }

  // Measured runs
  for (let i = 0; i < (spec.measuredRuns || 0); i++) {
    console.error(`[BENCH_RUN_BEGIN measured ${i}]`)
    try {
      const r = runOnceCli(spec)
      const stdoutMetrics = parseStdoutMetrics(r.stderr)
      const accuracy = scoreAnswer(r.text, spec.groundTruth)

      runs.push({
        index: i,
        ok: true,
        wallMs: r.wallMs,
        peakRssMb: r.peakRssMb,
        stats: null,
        stdoutMetrics,
        accuracy,
        fullAnswer: truncate(r.text, spec.answerTruncChars || 8000)
      })
    } catch (e) {
      runs.push({ index: i, ok: false, error: String((e && e.message) || e) })
    }
    console.error(`[BENCH_RUN_END measured ${i}]`)
    if (spec.cooldownMs) sleep(spec.cooldownMs)
  }

  const out = {
    cell: {
      sourceKey: spec.sourceKey,
      sourceLabel: spec.sourceLabel,
      backend: spec.backend,
      platform: os.platform(),
      arch: os.arch()
    },
    startedAt: cellStartedAt,
    finishedAt: new Date().toISOString(),
    runs,
    errors,
    spec
  }

  fs.writeFileSync(resultPath, JSON.stringify(out, null, 2))
  console.log(`[cli-case-runner] wrote ${resultPath}`)
}

// Reused by benchmarks/vlm-benchmark/cli-fixture-runner.cjs (several-sources mode).
module.exports = { buildCliArgs, getPatchedTemplate, extractGeneratedText, runOnceCli }

if (require.main === module) main()
