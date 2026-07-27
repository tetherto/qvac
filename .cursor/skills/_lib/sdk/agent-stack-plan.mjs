#!/usr/bin/env node
/**
 * Agent-stack cascade planner (read-only).
 *
 *   node .cursor/skills/_lib/sdk/agent-stack-plan.mjs
 *   node .cursor/skills/_lib/sdk/agent-stack-plan.mjs --json
 *   node .cursor/skills/_lib/sdk/agent-stack-plan.mjs --no-npm
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { getPackageDir, getNpmName } = require(
  '../../../../scripts/sdk/package-paths.cjs'
)

/** Lower → upper. */
const STACK = Object.freeze([
  { slug: 'sdk', role: 'runtime', dependsOn: null },
  {
    slug: 'cli',
    role: 'openai-http',
    dependsOn: 'sdk',
    depField: 'dependencies',
    depKey: '@qvac/sdk'
  },
  {
    slug: 'ai-sdk-provider',
    role: 'provider',
    dependsOn: 'cli',
    depField: 'peerDependencies',
    depKey: '@qvac/cli'
  },
  {
    slug: 'opencode-plugin',
    role: 'plugin',
    dependsOn: 'ai-sdk-provider',
    depField: 'dependencies',
    depKey: '@qvac/ai-sdk-provider',
    alsoDepends: [
      { dependsOn: 'cli', depField: 'dependencies', depKey: '@qvac/cli' }
    ]
  },
  {
    slug: 'openclaw-plugin',
    role: 'plugin',
    dependsOn: 'ai-sdk-provider',
    depField: 'dependencies',
    depKey: '@qvac/ai-sdk-provider',
    alsoDepends: [
      { dependsOn: 'cli', depField: 'dependencies', depKey: '@qvac/cli' }
    ]
  }
])

const NOISE_SUBJECT =
  /^(chore\[skiplog|Backmerge|Merge release|chore: wire in lunte|chore(?:\[[^\]]*\])?: release @qvac\/)/i

function parseArgs (argv) {
  const out = { json: false, npm: true, baseRef: 'upstream/main' }
  for (const arg of argv) {
    if (arg === '--json') out.json = true
    else if (arg === '--no-npm') out.npm = false
    else if (arg.startsWith('--base-ref=')) {
      out.baseRef = arg.slice('--base-ref='.length)
    }
  }
  return out
}

function repoRoot () {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8'
  }).trim()
}

function git (args, opts = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      cwd: opts.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (err) {
    if (opts.allowFail) return ''
    throw err
  }
}

function readPkgAtRef (root, baseRef, packageDir) {
  const rel = `${packageDir}/package.json`
  const fromGit = git(['show', `${baseRef}:${rel}`], {
    allowFail: true,
    cwd: root
  })
  if (fromGit) return JSON.parse(fromGit)
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    throw new Error(`Missing ${rel} at ${baseRef} and on disk`)
  }
  return JSON.parse(readFileSync(abs, 'utf8'))
}

function parseSemver (version) {
  const m = String(version)
    .replace(/^[^\d]*/, '')
    .match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] || 0)
  }
}

function bumpPatch (version) {
  const v = parseSemver(version)
  return v ? `${v.major}.${v.minor}.${v.patch + 1}` : null
}

function bumpMinor (version) {
  const v = parseSemver(version)
  return v ? `${v.major}.${v.minor + 1}.0` : null
}

/** 0.x carets do not cross minors. */
function rangeAllows (range, version) {
  if (!range || !version) return false
  const target = parseSemver(version)
  if (!target) return false
  for (const part of String(range).split('||').map((s) => s.trim())) {
    const m = part.match(/^\^?(\d+)\.(\d+)(?:\.(\d+))?/)
    if (!m) continue
    const major = Number(m[1])
    const minor = Number(m[2])
    if (major !== target.major) continue
    if (major === 0) {
      if (minor === target.minor) return true
      continue
    }
    if (minor <= target.minor) return true
  }
  return false
}

function npmView (name, fields) {
  try {
    const raw = execFileSync('npm', ['view', name, ...fields, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function latestTag (slug) {
  const out = git(['tag', '--list', `${slug}-v*`, '--sort=-v:refname'], {
    allowFail: true
  })
  return out ? out.split('\n')[0] : null
}

function outstandingCommits (tag, packageDir, baseRef) {
  if (!tag) return { subjects: [], meaningful: [] }
  const out = git(['log', '--oneline', `${tag}..${baseRef}`, '--', packageDir], {
    allowFail: true
  })
  if (!out) return { subjects: [], meaningful: [] }
  const subjects = out.split('\n').filter(Boolean)
  const meaningful = subjects.filter((line) => {
    const subject = line.replace(/^[0-9a-f]+\s+/i, '')
    return !NOISE_SUBJECT.test(subject)
  })
  return { subjects, meaningful }
}

function depChecksFor (spec) {
  const checks = []
  if (spec.dependsOn) {
    checks.push({
      dependsOn: spec.dependsOn,
      depField: spec.depField,
      depKey: spec.depKey
    })
  }
  for (const extra of spec.alsoDepends || []) checks.push(extra)
  return checks
}

function targetLowerVersion (lower) {
  if (!lower) return null
  if (lower.needsRelease && lower.recommendation?.suggested) {
    return lower.recommendation.suggested
  }
  return lower.publishedVersion || lower.localVersion || null
}

function evaluateDeps (entry, spec, bySlug) {
  const depResults = []
  const reasons = new Set(entry.reasons.filter((r) => r !== 'dep_bump'))
  for (const check of depChecksFor(spec)) {
    const lower = bySlug.get(check.dependsOn)
    const range = entry.localPkg[check.depField]?.[check.depKey] || null
    const targetLower = targetLowerVersion(lower)
    const allows = rangeAllows(range, targetLower)
    depResults.push({
      dependsOn: check.dependsOn,
      depKey: check.depKey,
      range,
      targetLower,
      allows
    })
    if (range && targetLower && !allows) reasons.add('dep_bump')
  }
  return { depResults, reasons: [...reasons] }
}

function detectAiSdkMismatch (localPkg, providerPkg) {
  if (!localPkg || !providerPkg) return null
  const upperAi = localPkg.dependencies?.ai || localPkg.peerDependencies?.ai
  const lowerAi =
    providerPkg.peerDependencies?.ai || providerPkg.dependencies?.ai
  if (!upperAi || !lowerAi) return null
  const upper = parseSemver(upperAi)
  const lower = parseSemver(lowerAi)
  if (!upper || !lower || upper.major === lower.major) return null
  return {
    code: 'ai_sdk_major_mismatch',
    message: `local ai major ${upper.major} vs provider ai major ${lower.major} — hold until plugin aligns`
  }
}

function hasTag (text, tag) {
  return new RegExp(`\\[[^\\]]*\\b${tag}\\b[^\\]]*\\]`).test(text)
}

function subjectLooksMinor (subjects) {
  return subjects.some((line) => {
    const s = line.replace(/^[0-9a-f]+\s+/i, '')
    return hasTag(s, 'bc') || hasTag(s, 'api') || /^feat(?:\[[^\]]*\])?:/i.test(s)
  })
}

function recommendVersion (entry) {
  const current = entry.localVersion
  if (entry.blockers.length > 0) {
    return {
      suggested: null,
      kind: 'blocked',
      rationale: entry.blockers.map((b) => b.message).join('; ')
    }
  }
  if (!entry.needsRelease) {
    return {
      suggested: null,
      kind: 'none',
      rationale: 'No release needed'
    }
  }
  if (
    entry.hasBreaking ||
    entry.reasons.includes('code_breaking') ||
    subjectLooksMinor(entry.outstanding)
  ) {
    return {
      suggested: bumpMinor(current),
      kind: 'minor',
      rationale: '0.x: [bc]/[api]/ or feat → minor'
    }
  }
  return {
    suggested: bumpPatch(current),
    kind: 'patch',
    rationale: entry.reasons.includes('code_changes')
      ? 'Outstanding non-breaking commits → patch'
      : 'Dependency-range alignment → patch'
  }
}

function inspectPackage (spec, ctx) {
  const dir = getPackageDir(spec.slug)
  const localPkg = readPkgAtRef(ctx.root, ctx.baseRef, dir)
  const npmName = getNpmName(spec.slug)
  const tag = latestTag(spec.slug)
  const commits = outstandingCommits(tag, dir, ctx.baseRef)

  let published = null
  if (ctx.npm) {
    const meta = npmView(npmName, [
      'version',
      'dependencies',
      'peerDependencies'
    ])
    if (meta && typeof meta === 'object') published = meta.version || null
  }

  const reasons = []
  const blockers = []

  if (commits.meaningful.length > 0) {
    const blob = commits.meaningful.join('\n')
    reasons.push(hasTag(blob, 'bc') ? 'code_breaking' : 'code_changes')
  }

  if (
    published &&
    localPkg.version === published &&
    commits.meaningful.length > 0 &&
    !reasons.includes('code_changes') &&
    !reasons.includes('code_breaking')
  ) {
    reasons.push('code_changes')
  }

  if (spec.role === 'plugin') {
    const provider = ctx.bySlug.get('ai-sdk-provider')
    const mismatch = detectAiSdkMismatch(localPkg, provider?.localPkg)
    if (mismatch) blockers.push(mismatch)
  }

  const entry = {
    slug: spec.slug,
    npmName,
    dir,
    role: spec.role,
    localVersion: localPkg.version,
    publishedVersion: published,
    tag,
    reasons: [...new Set(reasons)],
    needsRelease: false,
    needsWork: false,
    blockers,
    depResults: [],
    outstanding: commits.meaningful,
    hasBreaking: hasTag(commits.meaningful.join('\n'), 'bc'),
    localPkg,
    recommendation: null
  }

  const deps = evaluateDeps(entry, spec, ctx.bySlug)
  entry.depResults = deps.depResults
  entry.reasons = deps.reasons
  entry.needsWork = entry.reasons.length > 0
  entry.needsRelease = entry.needsWork && entry.blockers.length === 0
  entry.recommendation = recommendVersion(entry)
  return entry
}

function buildPlan (opts) {
  const root = repoRoot()
  const ctx = {
    root,
    npm: opts.npm,
    baseRef: opts.baseRef,
    bySlug: new Map()
  }

  const packages = []
  for (const spec of STACK) {
    const entry = inspectPackage(spec, ctx)
    ctx.bySlug.set(spec.slug, entry)
    packages.push(entry)
  }

  // Second pass: deps against finalized lower recommendations.
  for (let i = 0; i < STACK.length; i++) {
    const entry = packages[i]
    const deps = evaluateDeps(entry, STACK[i], ctx.bySlug)
    entry.depResults = deps.depResults
    entry.reasons = deps.reasons
    entry.needsWork = entry.reasons.length > 0
    entry.needsRelease = entry.needsWork && entry.blockers.length === 0
    entry.recommendation = recommendVersion(entry)
    ctx.bySlug.set(entry.slug, entry)
  }

  return {
    generatedAt: new Date().toISOString(),
    baseRef: opts.baseRef,
    npmQueried: opts.npm,
    packages: packages.map(({ localPkg: _lp, ...rest }) => rest)
  }
}

function renderMarkdown (plan) {
  const lines = [
    '# Agent stack cascade plan',
    '',
    `Base: \`${plan.baseRef}\` · npm: ${plan.npmQueried ? 'queried' : 'skipped'}`,
    '',
    '| Package | Local | npm | Needs release | Suggested | Why |',
    '|---|---|---|---|---|---|'
  ]

  for (const p of plan.packages) {
    const needs = p.blockers.length
      ? `blocked (${p.blockers[0].code})`
      : p.needsRelease
        ? 'yes'
        : 'no'
    lines.push(
      `| ${p.npmName} | ${p.localVersion} | ${p.publishedVersion || '?'} | ${needs} | ${p.recommendation?.suggested || '—'} | ${p.recommendation?.rationale || 'aligned'} |`
    )
  }
  lines.push('')

  for (const p of plan.packages) {
    if (!p.needsWork && p.blockers.length === 0) continue
    lines.push(`## ${p.npmName}`)
    lines.push(`- dir: \`${p.dir}\` · tag: \`${p.tag || 'none'}\``)
    lines.push(`- reasons: ${p.reasons.join(', ') || '—'}`)
    for (const d of p.depResults) {
      lines.push(
        `- dep ${d.depKey}: \`${d.range || 'missing'}\` vs ${d.targetLower} → ${d.allows ? 'ok' : 'NEEDS BUMP'}`
      )
    }
    for (const c of p.outstanding.slice(0, 8)) lines.push(`- ${c}`)
    for (const b of p.blockers) lines.push(`- blocker: ${b.message}`)
    lines.push('')
  }

  lines.push('Publish remains human-gated.')
  lines.push('')
  return lines.join('\n')
}

function main () {
  const opts = parseArgs(process.argv.slice(2))
  process.chdir(repoRoot())
  const plan = buildPlan(opts)
  process.stdout.write(
    opts.json ? JSON.stringify(plan, null, 2) + '\n' : renderMarkdown(plan)
  )
}

main()
