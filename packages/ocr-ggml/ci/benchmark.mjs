#!/usr/bin/env node
// OCRBench_v2 quality evaluation, as benchmark-ocr-ggml.yml ran it: each pipeline and task on each of this host's
// devices, into benchmarks/results. Dispatch options arrive in BENCHMARK_ARGS:
//   --pipeline easyocr|doctr|both  --tasks fullpage,spotting  --limit <n, 0 = all>  --[no-]skip-existing
// The configuration adds --devices and, on the CPU reference host, --reference.

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const EVAL = join(PKG, 'benchmarks/quality_eval')

export const TASKS = {
  fullpage: { types: 'full-page OCR en', filter: 'HierText', dir: 'full-page-ocr' },
  spotting: { types: 'text spotting en', filter: 'IC15', dir: 'text-spotting' }
}

export function options(dispatch, argv) {
  const { values } = parseArgs({
    args: [...dispatch, ...argv],
    options: {
      pipeline: { type: 'string', default: 'both' },
      tasks: { type: 'string', default: 'fullpage,spotting' },
      limit: { type: 'string', default: '0' },
      'skip-existing': { type: 'boolean', default: true },
      'no-skip-existing': { type: 'boolean', default: false },
      devices: { type: 'string', default: 'cpu' },
      reference: { type: 'boolean', default: false }
    },
    strict: true
  })
  if (!['easyocr', 'doctr', 'both'].includes(values.pipeline))
    throw new Error(`--pipeline must be easyocr, doctr or both, got '${values.pipeline}'`)
  if (!/^\d+$/.test(values.limit))
    throw new Error(`--limit must be a non-negative integer, got '${values.limit}'`)
  const tasks = values.tasks
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const unknown = tasks.filter((t) => !TASKS[t])
  if (unknown.length)
    throw new Error(`unknown --tasks ${unknown.join(', ')}; use fullpage, spotting`)
  return {
    pipeline: values.pipeline,
    tasks,
    limit: values.limit,
    skipExisting: values['skip-existing'] && !values['no-skip-existing'],
    devices: values.devices.split(',').filter(Boolean),
    reference: values.reference
  }
}

export function evaluateArgs(o, task, device, bare) {
  const models = (f) => join(PKG, 'models', f)
  const easyocr = o.pipeline !== 'doctr'
  const doctr = o.pipeline !== 'easyocr'
  return [
    'evaluate.py',
    '--dataset-path',
    'data/OCRBench_v2',
    '--pipeline',
    o.pipeline,
    ...(easyocr
      ? ['--detector', models('craft_mlt_25k.gguf'), '--recognizer', models('latin_g2.gguf')]
      : []),
    ...(doctr
      ? [
          '--doctr-detector',
          models('db_mobilenet_v3_large.gguf'),
          '--doctr-recognizer',
          models('crnn_mobilenet_v3_small.gguf')
        ]
      : []),
    '--task-types',
    TASKS[task].types,
    '--dataset-filter',
    TASKS[task].filter,
    '--results-dir',
    join(PKG, 'benchmarks/results', TASKS[task].dir),
    '--qvac-addon-path',
    PKG,
    '--bare-path',
    bare,
    '--qvac-device',
    device,
    o.reference ? '--reference' : '--no-reference',
    o.skipExisting ? '--skip-existing' : '--no-skip-existing',
    ...(o.limit !== '0' ? ['--limit', o.limit] : [])
  ]
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options(
    (process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean),
    process.argv.slice(2)
  )
  const hosted = process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  // The hosted CPU reference box needs Mesa's Vulkan loader and room for the dataset, as main gave it.
  if (process.platform === 'linux' && o.reference) {
    sh('bash', [
      '-c',
      'dpkg -s mesa-vulkan-drivers >/dev/null 2>&1 || (sudo apt-get update && sudo apt-get install -y mesa-vulkan-drivers)'
    ])
    if (hosted)
      sh('sudo', [
        'rm',
        '-rf',
        '/usr/share/dotnet',
        '/usr/local/lib/android',
        '/opt/ghc',
        '/opt/hostedtoolcache/CodeQL'
      ])
  }
  const venv = join(mkdtempSync(join(tmpdir(), 'ocr-eval-')), 'venv')
  sh(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', venv])
  const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  sh(python, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  // The self-hosted boxes take the trimmed requirements, as main installed them.
  sh(
    python,
    ['-m', 'pip', 'install', '-r', hosted ? 'requirements.txt' : 'requirements-qvac.txt'],
    { cwd: EVAL }
  )
  const bare = join(PKG, 'node_modules/.bin', process.platform === 'win32' ? 'bare.cmd' : 'bare')
  for (const task of o.tasks)
    for (const device of o.devices)
      sh(python, evaluateArgs(o, task, device, bare), {
        cwd: EVAL,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      })
}
