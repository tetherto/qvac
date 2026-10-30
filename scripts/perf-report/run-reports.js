#!/usr/bin/env node
'use strict'

// benchmarks.yml's perf report: every addon's report (PERF_ADDON=all, the weekly schedule) or one addon's
// from PERF_WORKFLOW, COMET scoring for nmtcpp, then the run summary. Reports land in reports/.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const PR = 'PR build and test'
const MOBILE = 'Mobile tests'
const VLM_FILTER = 'gemma4-vl|qwen3.5-vl'
// The package each report reads: the contract names its artifacts <slug>-perf-<config>-<n> and
// <slug>-perf-mobile-<platform>-<n>. VLM rows live in llm's artifacts (QVAC-18298).
const SLUGS = {
  nmtcpp: 'translation-nmtcpp',
  'llamacpp-llm': 'llm-llamacpp',
  vlm: 'llm-llamacpp',
  'asr-ggml': 'asr-ggml',
  'diffusion-cpp': 'diffusion-cpp',
  'audiogen-ggml': 'audiogen-ggml'
}
const WEEKLY = [
  ['Translation', 'nmtcpp', PR, 'nmtcpp-performance'],
  ['Vision/LLM (Desktop)', 'llamacpp-llm', PR, 'llamacpp-llm-performance'],
  ['Vision/LLM (Mobile)', 'llamacpp-llm', MOBILE, 'llamacpp-llm-mobile-performance', true],
  ['VLM (Desktop)', 'vlm', PR, 'vlm-performance'],
  ['VLM (Mobile)', 'vlm', MOBILE, 'vlm-mobile-performance', true],
  ['ASR (Mobile)', 'asr-ggml', MOBILE, 'asr-ggml-mobile-performance', true],
  ['Diffusion (Desktop)', 'diffusion-cpp', PR, 'diffusion-cpp-performance'],
  ['Diffusion (Mobile)', 'diffusion-cpp', MOBILE, 'diffusion-cpp-mobile-performance', true],
  ['ACE-Step (Desktop + Mobile)', 'audiogen-ggml', 'Benchmarks', 'audiogen-ggml-performance']
]

function node(script, args) {
  const res = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    stdio: 'inherit'
  })
  return res.status === 0
}

function aggregate(addon, workflow, runs, out, mobile = false) {
  const file = (ext) => path.join('reports', `${out}.${ext}`)
  // ACE-Step's desktop and mobile artifacts differ in shape, so it has its own aggregator.
  if (addon === 'audiogen-ggml') {
    return node('aggregate-audiogen-ggml-rtf.js', [
      '--workflow',
      workflow,
      '--runs',
      runs,
      '--output',
      file('md'),
      '--output-json',
      file('json')
    ])
  }
  const args = [
    '--addon',
    addon === 'vlm' ? 'llamacpp-llm' : addon,
    '--workflow',
    workflow,
    '--runs',
    runs
  ]
  args.push('--artifact-pattern', `${SLUGS[addon]}-perf-${mobile ? 'mobile-' : ''}*`)
  if (addon === 'vlm') args.push('--filter', VLM_FILTER)
  args.push('--output', file('md'), '--output-json', file('json'), '--output-html', file('html'))
  return node('aggregate.js', args)
}

// Best effort: a failed install or scoring never fails the run, so the chrF++ report still ships.
function comet(runs) {
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' })
  run('python', ['-m', 'pip', 'install', '--upgrade', 'pip'])
  // Pinned, so a new release or a PyTorch pin bump cannot change the scores unnoticed.
  run('python', ['-m', 'pip', 'install', 'unbabel-comet==2.2.6'])
  run('comet-score', ['--help'])
  node('comet-score-nmt.js', [
    '--runs',
    runs,
    '--workflow',
    PR,
    '--artifact-pattern',
    `${SLUGS.nmtcpp}-perf-*`,
    '--output',
    'reports/nmtcpp-comet.md',
    '--model',
    'Unbabel/wmt22-comet-da'
  ])
}

function summary() {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (!target) return
  const generated = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const parts = ['# Performance Reports', '', `Generated: ${generated} UTC`, '']
  const files = fs.existsSync('reports')
    ? fs.readdirSync('reports').filter((f) => f.endsWith('.md'))
    : []
  for (const f of files.sort()) {
    parts.push(fs.readFileSync(path.join('reports', f), 'utf8'), '', '---', '')
  }
  fs.appendFileSync(target, parts.join('\n') + '\n')
}

function main() {
  const addon = process.env.PERF_ADDON
  const runs = String(process.env.PERF_RUNS || 6)
  fs.mkdirSync('reports', { recursive: true })
  let ok = true
  if (addon === 'all') {
    for (const [heading, name, workflow, out, mobile] of WEEKLY) {
      console.log(`=== ${heading} ===`)
      aggregate(name, workflow, runs, out, mobile)
    }
  } else if (SLUGS[addon]) {
    ok = aggregate(addon, process.env.PERF_WORKFLOW, runs, `${addon}-performance`)
  } else {
    throw new Error(`PERF_ADDON: unknown addon ${JSON.stringify(addon)}`)
  }
  if (addon === 'all' || addon === 'nmtcpp') comet(runs)
  summary()
  if (!ok) process.exitCode = 1
}

main()
