'use strict'

// Behavioural coverage for load_mode. config-parameters.test.js asserts that
// every accepted value loads; this file asserts which memory path the engine
// actually took, which is the only way to tell a mode that ran from a mode that
// was silently ignored (mlock over RLIMIT_MEMLOCK and dio on a filesystem that
// refuses O_DIRECT both warn and continue rather than throwing).
//
// The discriminator is file-backed resident memory, not a log line: the
// engine's `load_mode = ...` line does not reach the addon logger. A mapped
// load holds the weights in file-backed pages; an anonymous load does not, and
// on a 1B model the gap is hundreds of MB.
//
// Each mode is measured in its OWN PROCESS. That is not tidiness — a second
// load in the same process cannot be measured. On the Vulkan backend `unload()`
// leaves ~190 MB of file-backed residency permanently resident, so the baseline
// shifts after the first load and every later delta reads short: the same mode
// measured three times in one process gave +373, +209, +209 MB. Measured in
// sequence, five different modes read 369 / 215 / 34 / 0.01 / -0.4 MB purely by
// load order.
//
// /proc is linux and android only. Elsewhere the memory assertions are skipped
// and only acceptance is checked.

const test = require('brittle')
const path = require('bare-path')
const os = require('bare-os')
const { spawnSync } = require('bare-subprocess')
const { ensureModel } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isMobile = platform === 'ios' || platform === 'android'
const useCpu =
  (platform === 'darwin' && arch === 'x64') || (platform === 'linux' && arch === 'arm64')

const MAPPING_MODES = ['mmap', 'mmap+mlock']
const ANONYMOUS_MODES = ['none', 'mlock', 'dio']

// Well below a 1B model's weights, comfortably above the incidental file-backed
// residency of the runtime and its shared libraries (~120-200 MB observed).
const MAPPED_FLOOR_BYTES = 300 * 1024 * 1024

const WORKER = path.join(__dirname, 'load-mode-worker.js')

// Runs one load in a fresh process and returns its file/anon RSS delta.
// Returns null when the split is unavailable (non-/proc platform) and throws
// when the load itself failed, so a broken mode fails the test rather than
// silently reading as "not mapped".
function measureInFreshProcess(modelPath, loadMode) {
  const result = spawnSync(os.execPath(), [WORKER, modelPath, loadMode, useCpu ? 'cpu' : 'gpu'], {
    encoding: 'utf8'
  })
  const stdout = String(result.stdout || '')
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{') && l.includes('"ok"'))
  if (!line) {
    throw new Error(
      `load_mode ${loadMode}: worker produced no result (status ${result.status}): ` +
        String(result.stderr || '')
          .trim()
          .split('\n')
          .slice(-2)
          .join(' | ')
    )
  }
  const parsed = JSON.parse(line)
  if (!parsed.ok) throw new Error(`load_mode ${loadMode}: ${parsed.error}`)
  return parsed.anonDelta === null ? null : parsed
}

test(
  'load_mode maps or does not map the weights as named',
  { timeout: 900_000, skip: isMobile },
  async (t) => {
    const [modelName, dirPath] = await ensureModel({
      modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
      downloadUrl:
        'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
    })
    const modelPath = path.join(dirPath, modelName)

    for (const mode of MAPPING_MODES) {
      const delta = measureInFreshProcess(modelPath, mode)
      if (!delta) {
        t.comment(`${mode}: loads; resident-memory split unavailable on ${platform}`)
        continue
      }
      t.comment(`${mode}: anon +${delta.anonDelta} file +${delta.fileDelta}`)
      t.ok(
        delta.fileDelta > MAPPED_FLOOR_BYTES,
        `${mode} holds the weights in file-backed pages (+${delta.fileDelta} bytes)`
      )
    }

    for (const mode of ANONYMOUS_MODES) {
      const delta = measureInFreshProcess(modelPath, mode)
      if (!delta) {
        t.comment(`${mode}: loads; resident-memory split unavailable on ${platform}`)
        continue
      }
      t.comment(`${mode}: anon +${delta.anonDelta} file +${delta.fileDelta}`)
      t.ok(
        delta.fileDelta < MAPPED_FLOOR_BYTES,
        `${mode} does not map the weights (file +${delta.fileDelta} bytes)`
      )
    }
  }
)

// `auto` picks its path from the selected devices: it maps unless one reports
// no mmap support (integrated GPUs, OpenCL, Hexagon). So the assertion is not
// "auto maps" but "auto lands on one of the two paths, not between them" —
// landing between would mean it resolved to neither. Which path it picks is a
// property of the host and is reported, not asserted.
test(
  'load_mode auto resolves to either the mapped or the anonymous path',
  { timeout: 900_000, skip: isMobile },
  async (t) => {
    const [modelName, dirPath] = await ensureModel({
      modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
      downloadUrl:
        'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
    })
    const modelPath = path.join(dirPath, modelName)

    const auto = measureInFreshProcess(modelPath, 'auto')
    if (!auto) {
      t.pass(`auto loads on ${platform}; resident-memory split unavailable to classify it`)
      return
    }

    const mmap = measureInFreshProcess(modelPath, 'mmap')
    const none = measureInFreshProcess(modelPath, 'none')

    const mapped = auto.fileDelta > MAPPED_FLOOR_BYTES
    const reference = mapped ? mmap : none
    t.comment(
      `auto resolved to ${mapped ? 'mmap' : 'none'} ` +
        `(auto file +${auto.fileDelta}, mmap file +${mmap.fileDelta}, none file +${none.fileDelta})`
    )

    // Within 10% of whichever path it chose, plus a fixed allowance for allocator
    // and page-cache noise between processes.
    const tolerance = Math.abs(reference.fileDelta) * 0.1 + 32 * 1024 * 1024
    t.ok(
      Math.abs(auto.fileDelta - reference.fileDelta) < tolerance,
      `auto matches the ${mapped ? 'mmap' : 'none'} path it resolved to ` +
        `(|${auto.fileDelta} - ${reference.fileDelta}| < ${tolerance})`
    )
  }
)
