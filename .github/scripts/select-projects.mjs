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
  'verify:deps',
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
// object with its runner, any extra host setup, its deployment environment and the labels that select it.
export const CONFIG_NAME = /^(linux|android|ios|darwin|win32)-(x64|arm64)(-[a-z0-9]+)?$/
const CONFIG_KEYS = ['args', 'commands', 'ci']
const CI_KEYS = ['runner', 'setup', 'environment', 'labels']
// A labels key is a PR label, or base:<branch> with an optional trailing * for a PR into that branch.
const LABEL_KEY = /^(base:[a-z0-9._-]+\*?|[a-z0-9-]+)$/
// Host setup a configuration may ask for; each is one workflow step, its version pinned in nx.json. cuda-jetson puts
// CUDA 12 for Jetson beside the host's CUDA 13 and exports only QVAC_CUDA_JETSON_PATH; java is JDK 17 and android the
// Android SDK, for a desktop leg that builds Kotlin.
const SETUP = ['cuda', 'cuda-jetson', 'rocm', 'python', 'java', 'android']

// The metadata a target may carry, and on which targets. toolchain is nx.json's, merged into every build target.
const METADATA = {
  timeoutMinutes: null,
  toolchain: ['build'],
  mobile: ['test:mobile'],
  publish: ['publish'],
  // Prebuild directories besides the platform ones that the meta package ships, such as fabric's include and share.
  prebuildExtraDirs: ['publish'],
  secrets: ['test:integration', 'test:backend', 'benchmark', 'test:mobile'],
  baseline: ['cpp:tests'],
  perfReport: ['test:integration'],
  // Toolkits a check target needs on pr-checks' runner, from CHECK_SETUP.
  setup: ['lint', 'typecheck', 'test:unit', 'verify:generated', 'verify:deps'],
  // How the checks install the package in place of the pnpm workspace: npm alone, as a consumer would, or its own
  // sdk-source:workspace script; published also checks it against npm on its own release branch and on a dispatch.
  sources: ['test:unit']
}
export const CHECK_SETUP = ['python', 'java', 'android-ndk', 'bare']
const CHECK_TARGETS = METADATA.setup
const SOURCES = ['npm', 'workspace', 'published']
// Secrets a target may ask for by name; each is named once in _desktop.yml or _mobile.yml, never indexed.
export const SECRETS = [
  'QASE_API_TOKEN',
  'HF_TOKEN',
  'MODEL_S3_BUCKET',
  'GITHUB_TOKEN',
  'MQTT_HOST',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  'MQTT_CA_CERT',
  'MQTT_CLIENT_CERT',
  'MQTT_CLIENT_KEY'
]
// platformPackages publishes one npm package per platform before the meta; nameTransform renames the GPR build;
// githubRelease names the GitHub release created after the npm publish; releaseGuard checks the release PR
// (pr-checks.yml); releaseNotes needs the version's CHANGELOG section before the npm publish.
const PUBLISH_KEYS = [
  'tagPrefix',
  'platformPackages',
  'nameTransform',
  'githubRelease',
  'releaseGuard',
  'releaseNotes'
]
const MOBILE_KEYS = [
  'devicefarmProject',
  'enablesPerf',
  'jobTimeoutMinutes',
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
    const labels = cfg.ci.labels ?? null
    if (labels !== null && target !== 'test:integration')
      throw new Error(`${where}: ci.labels routes test:integration configurations only`)
    if (labels !== null) {
      const bad = Object.entries(labels).filter(([k, v]) => !LABEL_KEY.test(k) || typeof v !== 'string')
      if (!Object.keys(labels).length || bad.length)
        throw new Error(`${where}: ci.labels maps each PR label or base:<branch> to the suite it passes`)
    }
    return {
      config,
      runnerKey: cfg.ci.runner,
      platform: m[1],
      arch: m[2],
      tags: m[3] ?? '',
      setup,
      environment: cfg.ci.environment ?? '',
      labels
    }
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
  const badSetup = (meta.setup ?? []).filter((s) => !CHECK_SETUP.includes(s))
  if (badSetup.length)
    throw new Error(`${project.name} ${target}: metadata.setup takes ${CHECK_SETUP.join(', ')}, found ${badSetup.join(', ')}`)
  const badSources = (meta.sources ?? []).filter((s) => !SOURCES.includes(s))
  if (badSources.length)
    throw new Error(`${project.name} ${target}: metadata.sources takes ${SOURCES.join(', ')}, found ${badSources.join(', ')}`)
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
    environment: '',
    labels: null,
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

// The gate's status key is the pr-gate-merge.yml filter key whose first path is the package (packages/<dir> or
// plugins/<dir>); later paths are dependencies.
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
    const dir = p[1].match(/^(?:packages|plugins)\/([^/]+)\/\*\*$/)
    if (dir) keys[dir[1]] ??= key
    key = null
  }
  return keys
}

// A build with configurations builds native prebuilds; one without is a JavaScript build, which gets no build row and
// no prebuilds to restore, and which the publish groups run before packing.
export const nativeBuild = (n) =>
  Object.keys(n.data.targets.build?.configurations ?? {}).length > 0
export const jsBuild = (n) => Boolean(n.data.targets.build) && !nativeBuild(n)

// configs, when set, keeps only those configurations: a mobile dispatch runs its one platform. prLabels and baseRef
// route the configurations that declare ci.labels; see routeLabelled.
export function select({ graph, affected, targets, labels, gate, configs = [], prLabels = [], baseRef = '' }) {
  const tagged = Object.values(graph.nodes).filter((n) => n.data.tags?.includes(TAG))
  const chosen = tagged.filter((n) => affected === null || affected.includes(n.name))
  const out = { matrices: {}, projects: [] }
  for (const t of targets) out.matrices[t] = []
  const common = (n) => {
    const dir = n.data.root.split('/').pop()
    const slug = slugOf(n)
    // Without a key no status is posted, and Merge Guard waits for one until its deadline. Only builds and C++ tests
    // post one, so a package with neither needs no key.
    if (!gate[dir] && (nativeBuild(n) || n.data.targets['cpp:tests']))
      throw new Error(
        `${n.name}: no pr-gate-merge.yml filter starts with "${n.data.root}/**", so it has no Merge Guard key`
      )
    const providers = providersOf(graph, n.name)
    return {
      slug,
      npm: npmName(n),
      key: gate[dir] ?? '',
      // The npm name whose platform packages provide the addon's symbols, and the slugs whose prebuilds it restores.
      provider: providers.length ? npmName(graph.nodes[providers[0]]) : '',
      providers: providers.map((p) => graph.nodes[p].data.root.split('/').pop()),
      targets: ['build'],
      // A package without a native build has no prebuilds to restore.
      hasBuild: nativeBuild(n),
      jsBuild: jsBuild(n),
      sources: n.data.targets['test:unit']?.metadata?.sources ?? []
    }
  }
  for (const n of chosen) {
    const project = { name: n.name, root: n.data.root, targets: n.data.targets }
    const own = targets.filter((t) => n.data.targets[t] && (t !== 'build' || nativeBuild(n)))
    if (!own.length) continue
    const c = { ...common(n), targets: own }
    out.projects.push({
      name: n.name,
      dir: n.data.root,
      ...c,
      benchmarkReport: Boolean(n.data.targets.benchmark?.configurations?.[REPORT]),
      cppBaseline: Boolean(n.data.targets['cpp:tests']?.metadata?.baseline),
      perfReport: n.data.targets['test:integration']?.metadata?.perfReport ?? null,
      checkSetup: [
        ...new Set(CHECK_TARGETS.flatMap((t) => n.data.targets[t]?.metadata?.setup ?? []))
      ],
      releaseGuard: Boolean(n.data.targets.publish?.metadata?.publish?.releaseGuard),
      prebuildStatus: PREBUILD_KEYS.includes(c.key),
      cppStatus: CPP_TEST_KEYS.includes(c.key)
    })
    for (const t of own) {
      for (const r of rows(project, t, labels)) {
        if (configs.length && r.config && !configs.includes(r.config)) continue
        out.matrices[t].push({ ...r, ...c })
      }
    }
  }
  if (out.matrices['test:integration']) {
    const routed = routeLabelled(out.matrices['test:integration'], { prLabels, baseRef })
    out.matrices['test:integration'] = routed.plain
    out.matrices['test:integration:labelled'] = routed.labelled
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
  // Providers build first, once per configuration, for the rows each build matrix and C++ lint feed.
  if (out.matrices.build) {
    const lint = out.matrices['cpp:lint'] ?? []
    const feeds = {
      'build:providers': [...out.matrices.build, ...lint],
      'build:baseline:providers': [...(out.matrices['build:baseline'] ?? []), ...lint],
      'cpp:lint:providers': lint
    }
    for (const [name, consumers] of Object.entries(feeds))
      out.matrices[name] = providerRows(graph, consumers, { labels, common })
    // A selected provider's own build rows move into its provider rows, so each configuration builds once.
    const id = (r) => `${r.project}@${r.config}`
    for (const [name, into] of [
      ['build', 'build:providers'],
      ['build:baseline', 'build:baseline:providers']
    ]) {
      if (!out.matrices[name]) continue
      const providing = providersIn(graph, out.matrices[name])
      const have = new Set(out.matrices[into].map(id))
      for (const r of out.matrices[name])
        if (providing.has(r.project) && !have.has(id(r))) out.matrices[into].push(r)
      out.matrices[name] = out.matrices[name].filter((r) => !providing.has(r.project))
    }
  }
  return out
}

// Rows whose configuration declares ci.labels run only when a label, or the PR's base branch, selects them, never on
// the stage labels; the first matching key in declaration order gives the suite the command reads as CI_SUITE.
export function routeLabelled(matrix, { prLabels = [], baseRef = '' }) {
  const plain = []
  const labelled = []
  const matches = (key) =>
    key.startsWith('base:')
      ? key.endsWith('*')
        ? baseRef.startsWith(key.slice(5, -1))
        : baseRef === key.slice(5)
      : prLabels.includes(key)
  for (const row of matrix) {
    if (!row.labels) {
      plain.push(row)
      continue
    }
    const hit = Object.keys(row.labels).find(matches)
    if (hit !== undefined) labelled.push({ ...row, label: hit, suite: row.labels[hit] })
  }
  return { plain, labelled }
}

const npmName = (n) => n.data.metadata?.js?.packageName ?? n.name
// The name in a package's release branches, tags and artifacts: its directory under packages/, else its unscoped npm
// name, so plugins/opencode releases from release-opencode-plugin-<x.y.z>.
export const slugOf = (n) =>
  n.data.root.startsWith('packages/')
    ? n.data.root.split('/').pop()
    : npmName(n).replace(/^@[^/]+\//, '')

// The contract packages whose link:platform one of this package's targets depends on, in declaration order. A
// provider off the contract is still built inside each consumer job, through the target's own dependencies.
export function providersOf(graph, name) {
  const out = []
  for (const target of Object.values(graph.nodes[name]?.data.targets ?? {}))
    for (const dep of target.dependsOn ?? [])
      if (dep?.target === 'link:platform')
        for (const p of dep.projects ?? [])
          if (p !== name && graph.nodes[p]?.data.tags?.includes(TAG) && !out.includes(p)) out.push(p)
  return out
}

// The selected rows' packages that another package in the graph links through link:platform.
function providersIn(graph, selected) {
  const all = new Set(Object.keys(graph.nodes).flatMap((name) => providersOf(graph, name)))
  return new Set(selected.map((r) => r.project).filter((p) => all.has(p)))
}

// One build row per provider and configuration the consumer rows use; a configuration the provider lacks fails.
export function providerRows(graph, consumers, { labels, common }) {
  const out = []
  const seen = new Set()
  for (const row of consumers) {
    for (const name of providersOf(graph, row.project)) {
      const key = `${name}@${row.config}`
      if (seen.has(key)) continue
      seen.add(key)
      const n = graph.nodes[name]
      if (!n.data.targets.build)
        throw new Error(`${name}: ${row.project} links its link:platform, but it has no build target`)
      const project = { name, root: n.data.root, targets: n.data.targets }
      const match = rows(project, 'build', labels).find((r) => r.config === row.config)
      if (!match)
        throw new Error(
          `${name}: ${row.project} ${row.target} configuration ${row.config} needs ${name}'s build configuration ${row.config}, which it does not define`
        )
      out.push({ ...match, ...common(n) })
    }
  }
  return out
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
          range.explicit.includes(n.name) ||
          range.explicit.includes(n.data.root.split('/').pop()) ||
          range.explicit.includes(slugOf(n))
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
  // As main's label-triggered runs: a label routes when it is the one just applied, a base branch on a PR's opening or
  // push; a dispatch names its labels.
  const pr = event.pull_request
  const prLabels = pr
    ? event.action === 'labeled' && event.label
      ? [event.label.name]
      : []
    : (env.LABELS || '').split(/[\s,]+/).filter(Boolean)
  const result = select({
    graph,
    affected,
    targets,
    labels,
    prLabels,
    baseRef: pr && ['opened', 'synchronize'].includes(event.action) ? pr.base.ref : '',
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
