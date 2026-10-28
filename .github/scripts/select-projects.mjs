#!/usr/bin/env node
// The one selection pass. It resolves the commits a run compares, lets `nx show projects --affected` pick the packages
// on the CI contract, checks their project.json against the standard (docs/ci/workflow-standard.md), and turns each
// target's configurations into job rows.

import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CPP_TEST_KEYS, PREBUILD_KEYS } from './prebuild-status/lib.mjs'

export const TAG = 'ci:contract'

// The standard target names. The groups run only these, and a package on the contract declares only these.
export const TARGETS = [
  'lint',
  'typecheck',
  'test:unit',
  'verify:generated',
  'ci:setup',
  'ci:system',
  'build',
  'link:platform',
  'cpp:lint',
  'cpp:build',
  'cpp:tests',
  'test:integration',
  'test:backend',
  'test:mobile',
  'cache:models',
  'benchmark',
  'publish'
]

// A configuration is named <platform>-<arch>[-<variant>] and holds only args or commands and a ci
// object with its runner and any extra host setup it needs.
export const CONFIG_NAME = /^(linux|android|ios|darwin|win32)-(x64|arm64)(-[a-z0-9]+)?$/
const CONFIG_KEYS = ['args', 'commands', 'ci']
const CI_KEYS = ['runner', 'setup']
// Host setup a configuration may ask for; each is one workflow step, its version pinned in nx.json.
const SETUP = ['cuda', 'rocm', 'python']

// The metadata a target may carry, and on which targets. toolchain is nx.json's, merged into every build target.
const METADATA = {
  timeoutMinutes: null,
  toolchain: ['build'],
  mobile: ['test:mobile'],
  publish: ['publish'],
  secrets: ['test:integration', 'test:backend', 'benchmark', 'test:mobile'],
  baseline: ['cpp:tests'],
  perfReport: ['test:integration']
}
// Secrets a target may ask for by name; each is named once in _desktop.yml or _mobile.yml, never indexed.
export const SECRETS = ['QASE_API_TOKEN', 'HF_TOKEN', 'MODEL_S3_BUCKET', 'GITHUB_TOKEN']
// platformPackages publishes one npm package per platform before the meta; nameTransform renames the GPR build.
const PUBLISH_KEYS = ['tagPrefix', 'platformPackages', 'nameTransform']
const MOBILE_KEYS = [
  'devicefarmProject',
  'enablesPerf',
  'mochaTimeoutMs',
  'perTestTimeoutMinutes',
  'perfReport',
  'waitforTimeoutMs'
]
// Each needs its secret named in _mobile.yml's PROJECT_ARN.
export const DEVICEFARM_PROJECTS = [
  'LLAMACPP_EMBED',
  'LLM',
  'OCR_FASTTEXT',
  'NMTCPP',
  'ASR_GGML',
  'TTS_GGML',
  'AUDIOGEN_GGML',
  'WHISPERCPP',
  'DECODER_AUDIO'
]

// benchmark's report configuration reads every other configuration's results, so it runs once, after them, never as a row.
export const REPORT = 'report'
const isReport = (target, config) => target === 'benchmark' && config === REPORT

export function configurations(project, target) {
  const entries = Object.entries(project.targets[target].configurations ?? {})
  return entries.filter(([config]) => !isReport(target, config)).map(([config, cfg]) => {
    const where = `${project.name} ${target} configuration ${config}`
    const m = config.match(CONFIG_NAME)
    if (!m) throw new Error(`${where}: the name must be <platform>-<arch>[-<variant>]`)
    const extra = Object.keys(cfg).filter((k) => !CONFIG_KEYS.includes(k))
    if (extra.length)
      throw new Error(
        `${where}: only ${CONFIG_KEYS.join(', ')} are allowed, found ${extra.join(', ')}`
      )
    const ciExtra = Object.keys(cfg.ci ?? {}).filter((k) => !CI_KEYS.includes(k))
    if (ciExtra.length)
      throw new Error(`${where}: ci holds only ${CI_KEYS.join(', ')}, found ${ciExtra.join(', ')}`)
    if (!cfg.ci?.runner) throw new Error(`${where}: ci.runner names the runner key it runs on`)
    const setup = cfg.ci.setup ?? []
    const unknown = setup.filter((s) => !SETUP.includes(s))
    if (unknown.length)
      throw new Error(`${where}: ci.setup takes ${SETUP.join(', ')}, found ${unknown.join(', ')}`)
    return { config, runnerKey: cfg.ci.runner, platform: m[1], arch: m[2], tags: m[3] ?? '', setup }
  })
}

export function checkMetadata(project, target) {
  const meta = project.targets[target]?.metadata ?? {}
  for (const key of Object.keys(meta)) {
    const on = METADATA[key]
    if (on === undefined || (on && !on.includes(target)))
      throw new Error(
        `${project.name} ${target}: metadata.${key} is not part of the package standard`
      )
  }
  if (meta.mobile) {
    const extra = Object.keys(meta.mobile).filter((k) => !MOBILE_KEYS.includes(k))
    if (extra.length)
      throw new Error(
        `${project.name} ${target}: metadata.mobile takes ${MOBILE_KEYS.join(', ')}, found ${extra.join(', ')}`
      )
    if (!DEVICEFARM_PROJECTS.includes(meta.mobile.devicefarmProject))
      throw new Error(
        `${project.name} ${target}: no Device Farm project secret is mapped for '${meta.mobile.devicefarmProject}'`
      )
  }
  const unknownSecrets = (meta.secrets ?? []).filter((s) => !SECRETS.includes(s))
  if (unknownSecrets.length)
    throw new Error(
      `${project.name} ${target}: metadata.secrets takes ${SECRETS.join(', ')}, found ${unknownSecrets.join(', ')}`
    )
  if (meta.publish) {
    const extra = Object.keys(meta.publish).filter((k) => !PUBLISH_KEYS.includes(k))
    if (extra.length)
      throw new Error(
        `${project.name} ${target}: metadata.publish takes ${PUBLISH_KEYS.join(', ')}, found ${extra.join(', ')}`
      )
  }
  return meta
}

// One row per configuration; a target without any is one job per package, on whatever runner the group picks.
export function rows(project, target, labels) {
  const meta = checkMetadata(project, target)
  const base = {
    project: project.name,
    dir: project.root,
    target,
    timeout: meta.timeoutMinutes ?? 0,
    meta,
    // The workspace toolchain pins live on nx.json's build target defaults.
    toolchain: project.targets.build?.metadata?.toolchain ?? {},
    config: '',
    platform: '',
    arch: '',
    tags: '',
    setup: [],
    runner: ''
  }
  // Nx gives every target a configurations object, empty when it has none.
  if (!Object.keys(project.targets[target]?.configurations ?? {}).length) return [base]
  return configurations(project, target).map((cfg) => {
    const runner = labels[cfg.runnerKey]
    if (!runner)
      throw new Error(
        `${project.name} ${target} configuration ${cfg.config}: unknown runner key ${cfg.runnerKey}`
      )
    return { ...base, ...cfg, runner }
  })
}

export function parseRunnerLabels(yaml) {
  return Object.fromEntries(
    [...yaml.matchAll(/echo "([a-z0-9_]+)=([^"]+)" >> "\$GITHUB_OUTPUT"/g)].map((m) => [m[1], m[2]])
  )
}

// The gate's status key is the pr-gate-merge.yml filter key whose first path is the package; later paths are dependencies.
export function gateKeys(gateYaml) {
  const keys = {}
  let key = null
  for (const line of gateYaml.split('\n')) {
    const k = line.match(/^ {12}([a-z0-9-]+):\s*$/)
    if (k) {
      key = k[1]
      continue
    }
    const p = line.match(/^ {14}- "([^"]+)"/)
    if (!p || !key) continue
    const dir = p[1].match(/^packages\/([^/]+)\/\*\*$/)
    if (dir) keys[dir[1]] ??= key
    key = null
  }
  return keys
}

// configs, when set, keeps only those configurations: a mobile dispatch runs its one platform.
export function select({ graph, affected, targets, labels, gate, configs = [] }) {
  const tagged = Object.values(graph.nodes).filter((n) => n.data.tags?.includes(TAG))
  const chosen = tagged.filter((n) => affected === null || affected.includes(n.name))
  const out = { matrices: {}, projects: [] }
  for (const t of targets) out.matrices[t] = []
  for (const n of chosen) {
    const project = { name: n.name, root: n.data.root, targets: n.data.targets }
    const own = targets.filter((t) => n.data.targets[t])
    if (!own.length) continue
    const dir = n.data.root.split('/').pop()
    // Without a key no status is posted, and Merge Guard waits for one until its deadline.
    if (!gate[dir])
      throw new Error(
        `${n.name}: no pr-gate-merge.yml filter starts with "packages/${dir}/**", so it has no Merge Guard key`
      )
    const { provider, providerArtifact } = nativeProvider(graph, n.name, gate)
    const common = {
      slug: dir,
      npm: n.data.metadata?.js?.packageName ?? n.name,
      key: gate[dir],
      provider,
      providerArtifact,
      targets: own,
      // A package without a build target has no prebuilds to restore.
      hasBuild: Boolean(n.data.targets.build)
    }
    out.projects.push({
      name: n.name,
      dir: n.data.root,
      ...common,
      benchmarkReport: Boolean(n.data.targets.benchmark?.configurations?.[REPORT]),
      cppBaseline: Boolean(n.data.targets['cpp:tests']?.metadata?.baseline),
      perfReport: n.data.targets['test:integration']?.metadata?.perfReport ?? null,
      prebuildStatus: PREBUILD_KEYS.includes(gate[dir]),
      cppStatus: CPP_TEST_KEYS.includes(gate[dir])
    })
    for (const t of own) {
      for (const r of rows(project, t, labels)) {
        if (configs.length && r.config && !configs.includes(r.config)) continue
        out.matrices[t].push({ ...r, ...common })
      }
    }
  }
  // A baseline package runs its C++ tests on every pull request, without the label, so new tests cannot land skipped
  // (QVAC-25289); these rows build and test it alone.
  const baseline = new Set(out.projects.filter((p) => p.cppBaseline).map((p) => p.name))
  if (out.matrices['cpp:tests']) {
    const tests = out.matrices['cpp:tests'].filter((r) => baseline.has(r.project))
    out.matrices['cpp:tests:baseline'] = tests
    // Only the builds those test hosts restore, not the package's every platform.
    const hosts = new Set(tests.map((r) => `${r.project}@${r.platform}-${r.arch}`))
    if (out.matrices.build)
      out.matrices['build:baseline'] = out.matrices.build.filter((r) => hosts.has(`${r.project}@${r.config}`))
  }
  return out
}

// The npm dependency the gate expects prebuilds from, and its <dir>-prebuilds bundle; its platform packages provide the addon's symbols.
export function nativeProvider(graph, name, gate) {
  const dep = (graph.dependencies[name] ?? []).find(
    (d) =>
      d.type === 'static' &&
      graph.nodes[d.target] &&
      PREBUILD_KEYS.includes(gate[graph.nodes[d.target].data.root.split('/').pop()])
  )
  if (!dep) return { provider: '', providerArtifact: '' }
  const node = graph.nodes[dep.target]
  return {
    provider: node.data.metadata?.js?.packageName ?? dep.target,
    providerArtifact: `${node.data.root.split('/').pop()}-prebuilds`
  }
}

// "desktop=test:integration+test:backend" adds one matrix holding both targets' rows, for targets that share a job.
export function combine(matrices, spec = '') {
  const out = {}
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [name, targets] = part.split('=')
    out[name] = targets.split('+').flatMap((t) => matrices[t] ?? [])
  }
  return out
}

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim()
const ZERO = /^0+$/

// Which commits a run compares. A pull request, on either PR event, is compared from its common ancestor with the
// base, as GitHub's "Files changed" shows it. workflow_call carries its caller's event, so it needs no row of its own.
export function resolveRange({ eventName, event, packages = [], defaultBranch, sha, ref }) {
  if (packages.length) return { explicit: packages }
  // A release-<dir>-<x.y.z> push publishes exactly the package its name holds, never its dependents.
  const release =
    eventName === 'push' && (ref ?? '').match(/^refs\/heads\/release-(.+)-\d+\.\d+\.\d+$/)
  if (release) return { explicit: [release[1]] }
  const pr = event.pull_request
  if (pr)
    return {
      base: pr.base.sha,
      head: pr.head.sha,
      mergeBase: true,
      headRepo: pr.head.repo?.full_name
    }
  if (eventName === 'merge_group')
    return { base: event.merge_group.base_sha, head: event.merge_group.head_sha }
  if (eventName === 'push') {
    const head = event.after || sha
    if (event.before && !ZERO.test(event.before)) return { base: event.before, head }
    return { base: `origin/${defaultBranch}`, head, mergeBase: true }
  }
  if (eventName === 'workflow_dispatch' && defaultBranch && ref !== `refs/heads/${defaultBranch}`) {
    return { base: `origin/${defaultBranch}`, head: sha, mergeBase: true }
  }
  return { all: true }
}

// The base and head commits, fetched (commits and trees only) so Nx can diff them; a merge base for a PR or a new branch.
export function shas(range, run = git) {
  const fetch = (rev, from = 'origin') =>
    run(['fetch', '--no-tags', '--filter=blob:none', from, rev])
  for (const rev of [range.base, range.head]) {
    if (rev.startsWith('origin/')) continue
    try {
      fetch(rev)
    } catch (e) {
      if (rev !== range.head || !range.headRepo) throw e
      fetch(rev, `https://github.com/${range.headRepo}.git`)
    }
  }
  return {
    base: range.mergeBase ? run(['merge-base', range.base, range.head]) : range.base,
    head: range.head
  }
}

function main(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const targets = env.TARGETS.split(/[\s,]+/).filter(Boolean)
  const unknown = targets.filter((t) => !TARGETS.includes(t))
  if (unknown.length) throw new Error(`not standard targets: ${unknown.join(', ')}`)
  const nx = (args, opts = {}) =>
    execFileSync('pnpm', ['exec', 'nx', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...opts
    })
  const tmp = join(env.RUNNER_TEMP, 'nx-graph.json')
  nx(['graph', `--file=${tmp}`], { stdio: 'inherit' })
  const graph = JSON.parse(readFileSync(tmp, 'utf8')).graph
  const range = resolveRange({
    eventName: env.GITHUB_EVENT_NAME,
    event,
    sha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    packages: (env.PACKAGES || '').split(/[\s,]+/).filter(Boolean),
    defaultBranch: event.repository?.default_branch
  })
  // affected stays null for "every tagged package": no change worth comparing, or commits that could not be fetched.
  let affected = null
  if (range.explicit) {
    affected = Object.values(graph.nodes)
      .filter(
        (n) =>
          range.explicit.includes(n.name) || range.explicit.includes(n.data.root.split('/').pop())
      )
      .map((n) => n.name)
  } else if (!range.all) {
    try {
      const { base, head } = shas(range)
      console.log(`Comparing ${base}..${head}`)
      affected = JSON.parse(
        nx(['show', 'projects', '--affected', `--base=${base}`, `--head=${head}`, '--json'])
      )
    } catch (e) {
      console.log(
        `::warning::could not compare ${range.base}..${range.head}, selecting every tagged package: ${e.message}`
      )
    }
  }
  const labels = parseRunnerLabels(
    readFileSync('.github/workflows/reusable-runner-names.yml', 'utf8')
  )
  const result = select({
    graph,
    affected,
    targets,
    labels,
    configs: (env.CONFIGS || '').split(/[\s,]+/).filter(Boolean),
    gate: gateKeys(readFileSync('.github/workflows/pr-gate-merge.yml', 'utf8'))
  })
  Object.assign(result.matrices, combine(result.matrices, env.COMBINE))
  for (const [t, r] of Object.entries(result.matrices))
    console.log(
      `${t}: ${r.map((x) => `${x.project}${x.config ? `@${x.config}` : ''}`).join(' ') || 'none'}`
    )
  appendFileSync(
    env.GITHUB_OUTPUT,
    `matrices=${JSON.stringify(result.matrices)}\nprojects=${JSON.stringify(result.projects)}\nrunners=${JSON.stringify(labels)}\nany=${result.projects.length > 0}\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
