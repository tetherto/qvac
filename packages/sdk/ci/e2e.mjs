#!/usr/bin/env node
// The sdk's test:integration, one leg of main's desktop, python, electron or snap family: this commit's inference and
// test-suite packed into the sdk and sdk-e2e npm installs, the consumer and the producer over MQTT, the results checked
// and compared with the newest dispatch run on the base branch. Usage: node ci/e2e.mjs <family>.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
export const SDK = join(ROOT, 'packages/sdk')
export const E2E = join(ROOT, 'packages/sdk-e2e')
const FAMILIES = ['desktop', 'python', 'electron', 'snap']
// Checked before any value reaches a command line, as main's run step did.
export const SAFE_LIST = /^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$/

// npm and npx are .cmd shims on Windows, which Node only spawns through a shell.
export function run(cmd, args, { cwd = ROOT, env = process.env, capture = false } = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  })
}

export const list = (name, value) => {
  const out = (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
  if (out && !SAFE_LIST.test(out)) throw new Error(`${name} does not match ${SAFE_LIST}`)
  return out
}

export function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

// main's MQTT certificate step: each set secret into a file the test config reads by path.
export function mqttCerts(env) {
  const dir = join(tmpdir(), 'mqtt-certs')
  mkdirSync(dir, { recursive: true })
  const out = {}
  for (const [secret, file, name] of [
    ['MQTT_CA_CERT', 'ca.crt', 'MQTT_CA_PATH'],
    ['MQTT_CLIENT_CERT', 'client.crt', 'MQTT_CERT_PATH'],
    ['MQTT_CLIENT_KEY', 'client.key', 'MQTT_KEY_PATH']
  ]) {
    const value = (env[secret] || '').trim()
    if (!value) continue
    writeFileSync(join(dir, file), value)
    out[name] = join(dir, file)
  }
  return { ...env, ...out }
}

// The npm installs main's e2e jobs made: registries, this commit's inference and test-suite as tarballs, the sdk
// built, then the sdk-e2e consumer installed against it and built. pnpm's node_modules go first.
export function prepare(env) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is empty; the @tetherto registry needs it')
  for (const dir of ['sdk', 'sdk-e2e', 'inference', 'test-suite']) {
    rmSync(join(ROOT, 'packages', dir, 'node_modules'), { recursive: true, force: true })
  }
  const npmrc = [
    'registry=https://registry.npmjs.org/',
    '@qvac:registry=https://registry.npmjs.org/',
    '@tetherto:registry=https://npm.pkg.github.com/',
    `//npm.pkg.github.com/:_authToken=${env.GITHUB_TOKEN}`
  ].join('\n')
  writeFileSync(join(SDK, '.npmrc'), npmrc)
  const tmp = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'sdk-e2e-'))
  const sha = run('git', ['rev-parse', 'HEAD'], { capture: true }).trim()
  for (const [script, prefix, project] of [
    ['e2e-inference.mjs', 'INFERENCE', 'packages/sdk'],
    ['e2e-test-suite.mjs', 'TEST_SUITE', 'packages/sdk-e2e']
  ]) {
    const dir = join(tmp, prefix.toLowerCase())
    const step = {
      ...env,
      GITHUB_OUTPUT: '',
      [`${prefix}_SOURCE`]: 'branch',
      [`${prefix}_ARTIFACT_DIRECTORY`]: dir,
      ARTIFACT_DIRECTORY: dir,
      PROJECT_DIRECTORY: project,
      CHECKOUT_SHA: sha
    }
    for (const command of ['resolve', 'apply']) {
      run('node', [join(SDK, 'ci', script), command], { env: step })
    }
  }
  run('npm', ['install', '--ignore-scripts'], { cwd: SDK, env })
  run('npm', ['run', 'build'], { cwd: SDK, env })
  writeFileSync(join(E2E, '.npmrc'), npmrc)
  run('npm', ['install', '--install-links'], { cwd: E2E, env })
  run('npm', ['run', 'build'], { cwd: E2E, env })
  return mqttCerts(env)
}

async function github(env, path) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res
}

// The baseline: the newest dispatch run of the workflow on the base branch (a PR's, else the default branch for a
// dispatch from another branch) that uploaded the same artifact. Best effort: any miss skips the comparison.
export async function compareBaseline({ env, workflow, artifact, reports, label }) {
  try {
    const event = env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
      : {}
    const base =
      env.GITHUB_BASE_REF ||
      (env.GITHUB_REF_NAME !== event.repository?.default_branch
        ? event.repository?.default_branch
        : '')
    const current = existsSync(reports)
      ? readdirSync(reports).filter((f) => f.startsWith('results-') && f.endsWith('.json'))
      : []
    if (!base || !current.length) return console.log('No base branch or no results: no comparison.')
    const runs = await (
      await github(
        env,
        `actions/workflows/${workflow}/runs?branch=${encodeURIComponent(base)}&event=workflow_dispatch&status=completed&per_page=30`
      )
    ).json()
    for (const r of runs.workflow_runs ?? []) {
      const found = await (
        await github(env, `actions/runs/${r.id}/artifacts?name=${artifact}`)
      ).json()
      const hit = (found.artifacts ?? []).find((a) => !a.expired)
      if (!hit) continue
      const dir = mkdtempSync(join(tmpdir(), 'baseline-'))
      const zip = join(dir, 'baseline.zip')
      const res = await github(env, `actions/artifacts/${hit.id}/zip`)
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
      if (process.platform === 'win32') run('tar', ['-xf', zip, '-C', dir])
      else run('unzip', ['-qo', zip, '-d', dir])
      const baseline = readdirSync(dir, { recursive: true })
        .map(String)
        .find((f) => /(^|[\\/])results-[^\\/]*\.json$/.test(f))
      if (!baseline) continue
      console.log(`Baseline: run ${r.id} on ${base}`)
      const comparison = join(E2E, `comparison-${label}.json`)
      const section = join(E2E, `section-${label}.md`)
      run(
        'npx',
        [
          'qvac-test',
          'report:compare',
          '--baseline',
          join(dir, baseline),
          '--current',
          join(reports, current[0]),
          '--output',
          comparison
        ],
        { cwd: E2E }
      )
      run(
        'npx',
        [
          'qvac-test',
          'report:format',
          '--input',
          comparison,
          '--format',
          'markdown',
          '--output',
          section
        ],
        { cwd: E2E }
      )
      summary(readFileSync(section, 'utf8'))
      return
    }
    console.log(`No ${artifact} baseline on ${base}: no comparison.`)
  } catch (e) {
    console.log(`::warning::Baseline comparison skipped: ${e.message}`)
  }
}

// main's fail-on-failures step: every results file has a numeric summary.failed, and all are zero.
export function failOnFailures(reports) {
  const files = existsSync(reports)
    ? readdirSync(reports)
        .filter((f) => f.startsWith('results-') && f.endsWith('.json'))
        .sort()
    : []
  if (!files.length) throw new Error('No results-*.json; cannot verify the e2e result summary.')
  let failed = 0
  for (const f of files) {
    const s = JSON.parse(readFileSync(join(reports, f), 'utf8')).summary
    if (typeof s?.failed !== 'number') throw new Error(`${f} has no numeric summary.failed`)
    console.log(`${f}: ${s.failed} failed / ${s.total ?? 0} total`)
    failed += s.failed
  }
  if (failed) throw new Error(`E2E results contain ${failed} failed test(s).`)
}

// Results go where the group uploads them: <package>/test/results/e2e.
export function keepResults(into, files) {
  mkdirSync(into, { recursive: true })
  for (const f of files) {
    if (existsSync(f)) cpSync(f, join(into, f.split(/[\\/]/).pop()), { recursive: true })
  }
}

const platformOf = (label) => {
  const s = String(label).toLowerCase()
  return s.includes('win')
    ? 'windows'
    : s.includes('mac') || s.includes('darwin')
      ? 'macos'
      : 'linux'
}

// main's sdk-python-venv: the runner's own Python, 3.10 or later, in a venv the python consumer's config points at.
function pythonVenv(env) {
  const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python'
  run(py, ['-c', 'import sys; assert sys.version_info[:2] >= (3, 10), sys.version'], { env })
  const venv = join(ROOT, 'packages/sdk-python/.venv')
  run(py, ['-m', 'venv', venv], { env })
  const bin = join(venv, existsSync(join(venv, 'bin/python')) ? 'bin/python' : 'Scripts/python')
  run(bin, ['-m', 'pip', 'install', '--upgrade', 'pip'], { env })
  run(bin, ['-m', 'pip', 'install', '-e', `${join(ROOT, 'packages/sdk-python')}[dev]`], { env })
}

// main's strict Snap steps: tooling, the LXD egress preflight, two revisions and the refresh test, install, interfaces.
function snapBuild(env) {
  rmSync(join(E2E, '.npmrc'), { force: true })
  const sh = (script) => run('bash', ['-c', script], { cwd: E2E, env })
  sh('command -v snapcraft || sudo snap install snapcraft --classic')
  if (env.QVAC_TEST_SNAP_BUILD_MODE === 'lxd') {
    sh(
      'command -v lxc || { echo "::error::LXD is required for non-destructive Snap builds"; exit 1; }; lxc info'
    )
    sh(
      'set -euo pipefail; probe="qvac-egress-preflight-$$"; trap \'lxc delete -f "$probe" >/dev/null 2>&1 || true\' EXIT; ' +
        'lxc launch ubuntu:22.04 "$probe"; for _ in $(seq 1 20); do lxc exec "$probe" -- getent hosts github.com >/dev/null 2>&1 && break; sleep 2; done; ' +
        'lxc exec "$probe" -- curl -4 -fsS --max-time 15 -o /dev/null https://github.com || { echo "::error::LXD build instances cannot reach github.com over IPv4 (Docker FORWARD DROP without an lxdbr0 ACCEPT); enable lxd-docker-forward.service (qvac-devops ansible --tags snap-fw)"; exit 1; }'
    )
  }
  sh('snap version && snapcraft --version')
  const build = (id) =>
    run('npx', ['qvac-test', 'build:consumer:snap', '--config=.', '--skip-install'], {
      cwd: E2E,
      env: { ...env, QVAC_TEST_SNAP_BUILD_ID: id, TMPDIR: env.RUNNER_TEMP || tmpdir() }
    })
  build('first')
  copyFileSync(
    join(E2E, 'snap/dist/qvac-sdk-e2e.snap'),
    join(E2E, 'snap/dist/qvac-sdk-e2e-first.snap')
  )
  build('second')
  run(
    'npm',
    [
      'run',
      'test:snap:refresh',
      '--',
      '--first',
      'snap/dist/qvac-sdk-e2e-first.snap',
      '--second',
      'snap/dist/qvac-sdk-e2e.snap'
    ],
    { cwd: E2E, env }
  )
  sh('sudo snap install --dangerous snap/dist/qvac-sdk-e2e.snap')
  sh(
    'sudo snap connect qvac-sdk-e2e:opengl && sudo snap connect qvac-sdk-e2e:hardware-observe && ' +
      'sudo snap connect qvac-sdk-e2e:graphics-core22 mesa-core22:graphics-core22 && snap list mesa-core22 && snap connections qvac-sdk-e2e'
  )
}

// main's run step: the consumer in the background, the producer in the foreground for up to 60 minutes.
async function consumerAndProducer({ env, runId, family, filter, suite }) {
  const external = family === 'python'
  const consumerArgs = [
    'qvac-test',
    external ? 'run:consumer:external' : `run:consumer:${family}`,
    `--runId=${runId}`,
    '--config=.',
    ...(external ? ['--name=python'] : []),
    ...(family === 'electron' ? ['--skip-build'] : []),
    ...(family === 'snap' ? ['--skip-build', '--skip-snap-install'] : [])
  ]
  console.log(`Consumer: npx ${consumerArgs.join(' ')}`)
  const consumer = spawn('npx', consumerArgs, { cwd: E2E, env, shell: true, stdio: 'inherit' })
  let closed = false
  let consumerExit = 0
  const done = new Promise((resolve) =>
    consumer.on('close', (code) => {
      closed = true
      consumerExit = code ?? 0
      resolve()
    })
  )
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (closed) throw new Error('Consumer died immediately')
  const producerArgs = [
    'qvac-test',
    'run:producer',
    `--runId=${runId}`,
    '--consumer-timeout=60',
    '--config=.',
    '--report-dir=./reports',
    ...(filter ? [`--filter=${filter}`] : []),
    ...(suite ? [`--suite=${suite}`] : [])
  ]
  console.log(`Producer: npx ${producerArgs.join(' ')}`)
  const producer = spawnSync('npx', producerArgs, {
    cwd: E2E,
    env,
    shell: true,
    stdio: 'inherit',
    timeout: 60 * 60 * 1000
  })
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 30000))])
  if (!closed) {
    console.log('Consumer did not close within 30s; stopping it.')
    consumer.kill('SIGTERM')
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))])
  }
  return producer.status === 0 ? consumerExit : producer.status || 1
}

async function main(family, env) {
  if (!FAMILIES.includes(family)) throw new Error(`family must be one of ${FAMILIES.join(', ')}`)
  const platform = platformOf(env.CI_RUNNER_LABEL)
  if (family === 'snap' && platform !== 'linux') throw new Error('Snap runs on Linux only')
  const suite = list('suite', env.CI_SUITE)
  const label = `${family}-${platform}`
  const reports = join(E2E, 'reports')
  let e = prepare(env)
  let status = 1
  try {
    if (family === 'python') pythonVenv(e)
    if (family === 'desktop' || family === 'python') {
      run('npm', ['run', 'bundle:sdk'], { cwd: E2E, env: e })
    }
    if (family === 'snap') {
      e = {
        ...e,
        QVAC_TEST_SNAP_BUILD_MODE: /^ubuntu-/.test(env.CI_RUNNER_LABEL) ? 'destructive' : 'lxd'
      }
      snapBuild(e)
      run(
        'npx',
        ['qvac-test', 'run:bootstrap:snap', '--config=.', '--skip-build', '--skip-snap-install'],
        { cwd: E2E, env: e }
      )
    } else {
      const cacheDir = join(E2E, '.qvac-cache')
      mkdirSync(cacheDir, { recursive: true })
      const config = join(E2E, 'qvac.config.ci.json')
      writeFileSync(config, `${JSON.stringify({ cacheDirectory: cacheDir }, null, 2)}\n`)
      e = { ...e, QVAC_CONFIG_PATH: config }
      run(
        'npx',
        ['qvac-test', `run:bootstrap:${family === 'python' ? 'desktop' : family}`, '--config=.'],
        { cwd: E2E, env: e }
      )
    }
    if (family === 'electron') {
      run('npx', ['qvac-test', 'build:consumer:electron', '--config=.', '--skip-install'], {
        cwd: E2E,
        env: e
      })
    }
    const sha = run('git', ['rev-parse', '--short=7', 'HEAD'], { capture: true }).trim()
    const runId = `${platform}-${sha}-${family}-${Number(env.GITHUB_RUN_ID || Date.now()).toString(36)}-${env.GITHUB_RUN_ATTEMPT || 1}`
    status = await consumerAndProducer({ env: e, runId, family, filter: '', suite })
  } finally {
    if (family === 'snap') {
      // Best effort, as main's two optional steps: removing the snap stops its processes; denials explain a failure.
      spawnSync('bash', ['-c', 'sudo snap remove --purge qvac-sdk-e2e'], { stdio: 'inherit' })
      if (status !== 0) {
        spawnSync(
          'bash',
          [
            '-c',
            `sudo journalctl --dmesg --no-pager --since "10 minutes ago" --grep 'apparmor="DENIED"|audit'`
          ],
          { stdio: 'inherit' }
        )
      }
    }
    const dist = join(E2E, 'snap/dist')
    const snaps =
      family === 'snap' && existsSync(dist)
        ? readdirSync(dist)
            .filter((f) => f.endsWith('.snap'))
            .map((f) => join(dist, f))
        : []
    keepResults(join(SDK, 'test/results/e2e', label), [
      reports,
      join(E2E, 'consumer.log'),
      ...snaps
    ])
    await compareBaseline({
      env: e,
      workflow: 'pr-build-test.yml',
      artifact: `sdk-results-${env.CONFIG}`,
      reports,
      label
    })
  }
  try {
    failOnFailures(reports)
    if (status !== 0) throw new Error(`Tests failed with exit code ${status}`)
  } catch (err) {
    if (existsSync(join(E2E, 'consumer.log'))) {
      console.log(readFileSync(join(E2E, 'consumer.log'), 'utf8'))
    }
    throw err
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.env).catch((err) => {
    console.log(`::error::${err.message}`)
    process.exit(1)
  })
}
