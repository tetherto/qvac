import { existsSync, readFileSync } from 'node:fs'

// Enforces docs/branch-retention.md. Two-phase: flag candidates into a tracking
// issue ledger, then delete only after a grace period (or maintainer ack).

const DAY_MS = 24 * 60 * 60 * 1000
const LEDGER_LABEL = 'branch-cleanup'
const LEDGER_TITLE = 'Branch cleanup — pending deletions'
const LEDGER_BEGIN = '<!-- branch-cleanup:ledger:begin -->'
const LEDGER_END = '<!-- branch-cleanup:ledger:end -->'
// Only acks from users with write-ish association to the repo are honoured.
const TRUSTED_ASSOCIATION = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

const RELEASE_MONO_RE = /^release-(.+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
const RELEASE_SINGLE_RE = /^release-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
const TAG_MONO_RE = /^(.+)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
const TAG_SINGLE_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
const WIP_RE = /(^|[^a-z])wip([^a-z]|$)/i
const SINGLE_PACKAGE_KEY = '__single__'

function toInt (value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readConfig (env) {
  return {
    dryRun: String(env.DRY_RUN).toLowerCase() === 'true',
    singlePackage: String(env.SINGLE_PACKAGE).toLowerCase() === 'true',
    gracePeriodDays: toInt(env.GRACE_PERIOD_DAYS, 7),
    keepMajors: toInt(env.KEEP_MAJORS, 2),
    keepMinors: toInt(env.KEEP_MINORS, 3),
    keepPatches: toInt(env.KEEP_PATCHES, 1),
    featureInactivityDays: toInt(env.FEATURE_INACTIVITY_DAYS, 60),
    tmpInactivityDays: toInt(env.TMP_INACTIVITY_DAYS, 60),
    adhocInactivityDays: toInt(env.ADHOC_INACTIVITY_DAYS, 30),
    maxDeletionsPerRun: toInt(env.MAX_DELETIONS_PER_RUN, 10),
    timestampsFile: env.BRANCH_TIMESTAMPS_FILE || ''
  }
}

function parseSemver (raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] || null,
    raw
  }
}

function descNumbers (a, b) {
  return b - a
}

// Classify a branch by its name into one of the gitflow types.
function classifyBranch (name, cfg) {
  if (cfg.singlePackage) {
    const single = RELEASE_SINGLE_RE.exec(name)
    if (single) {
      return { type: 'release', package: SINGLE_PACKAGE_KEY, version: parseSemver(single[1]) }
    }
  } else {
    const mono = RELEASE_MONO_RE.exec(name)
    if (mono) {
      return { type: 'release', package: mono[1], version: parseSemver(mono[2]) }
    }
  }
  if (name.startsWith('feature-')) return { type: 'feature' }
  if (name.startsWith('tmp-')) return { type: 'tmp' }
  return { type: 'adhoc' }
}

// Map each package to its highest *stable* released version, from git tags.
function latestPublishedByPackage (tags, cfg) {
  const latest = new Map()
  for (const tag of tags) {
    let pkg
    let versionRaw
    if (cfg.singlePackage) {
      const match = TAG_SINGLE_RE.exec(tag.name)
      if (!match) continue
      pkg = SINGLE_PACKAGE_KEY
      versionRaw = match[1]
    } else {
      const match = TAG_MONO_RE.exec(tag.name)
      if (!match) continue
      pkg = match[1]
      versionRaw = match[2]
    }
    const version = parseSemver(versionRaw)
    if (!version || version.prerelease) continue // latest dist-tag is stable
    const current = latest.get(pkg)
    if (!current || compareStableDesc(version, current) < 0) {
      latest.set(pkg, version)
    }
  }
  return latest
}

// Returns negative when `a` is newer than `b` (for ascending sorts / "is newer" checks).
function compareStableDesc (a, b) {
  if (a.major !== b.major) return b.major - a.major
  if (a.minor !== b.minor) return b.minor - a.minor
  return b.patch - a.patch
}

// Branch name that backs the latest published version for a package.
function latestReleaseBranchName (pkg, version, cfg) {
  if (cfg.singlePackage) return `release-${version.raw}`
  return `release-${pkg}-${version.raw}`
}

// Apply the nested-semver window per package; return the set of eligible branches.
function eligibleReleaseBranches (releases, cfg) {
  const eligible = new Set()
  const byPackage = new Map()
  for (const release of releases) {
    if (!release.version) continue
    if (release.version.prerelease) continue // handled as temp elsewhere
    if (!byPackage.has(release.package)) byPackage.set(release.package, [])
    byPackage.get(release.package).push(release)
  }

  for (const items of byPackage.values()) {
    const majors = [...new Set(items.map((r) => r.version.major))].sort(descNumbers)
    const keptMajors = new Set(majors.slice(0, cfg.keepMajors))

    for (const release of items) {
      const { major, minor } = release.version
      if (!keptMajors.has(major)) {
        eligible.add(release.name)
        continue
      }
      const minorsInMajor = [
        ...new Set(items.filter((r) => r.version.major === major).map((r) => r.version.minor))
      ].sort(descNumbers)
      const keptMinors = new Set(minorsInMajor.slice(0, cfg.keepMinors))
      if (!keptMinors.has(minor)) {
        eligible.add(release.name)
        continue
      }
      const patchesInMinor = [
        ...new Set(
          items
            .filter((r) => r.version.major === major && r.version.minor === minor)
            .map((r) => r.version.patch)
        )
      ].sort(descNumbers)
      const keptPatches = new Set(patchesInMinor.slice(0, cfg.keepPatches))
      if (!keptPatches.has(release.version.patch)) {
        eligible.add(release.name)
      }
    }
  }
  return eligible
}

function loadBranchTimestamps (file) {
  if (!file || !existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

async function lastCommitTimestampMs (github, owner, repo, branch, sha, timestamps) {
  const fromFile = timestamps[branch]
  if (Number.isFinite(fromFile)) return Number(fromFile) * 1000
  try {
    const { data } = await github.rest.repos.getCommit({ owner, repo, ref: sha })
    const date = data.commit?.committer?.date || data.commit?.author?.date
    if (date) return new Date(date).getTime()
  } catch {
    // fall through
  }
  return null
}

// Most recent PR-side activity for a branch used as a PR head (any PR state).
async function lastPrActivityMs (github, owner, repo, branch) {
  try {
    const prs = await github.paginate(github.rest.pulls.list, {
      owner,
      repo,
      state: 'all',
      head: `${owner}:${branch}`,
      per_page: 100
    })
    let latest = null
    for (const pr of prs) {
      const stamp = new Date(pr.updated_at).getTime()
      if (latest === null || stamp > latest) latest = stamp
    }
    return latest
  } catch {
    return null
  }
}

function parseLedger (body) {
  const empty = { version: 1, exempt: [], pending: {} }
  if (!body) return empty
  const start = body.indexOf(LEDGER_BEGIN)
  const end = body.indexOf(LEDGER_END)
  if (start === -1 || end === -1 || end < start) return empty
  const raw = body.slice(start + LEDGER_BEGIN.length, end).trim()
  const jsonStart = raw.indexOf('{')
  const jsonEnd = raw.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) return empty
  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1))
    return {
      version: 1,
      exempt: Array.isArray(parsed.exempt) ? parsed.exempt : [],
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {}
    }
  } catch {
    return empty
  }
}

// Maintainer ack keywords from trusted commenters: `keep: <branch>` / `delete-now: <branch>`.
function parseAcks (comments) {
  const keep = new Set()
  const deleteNow = new Set()
  for (const comment of comments) {
    if (!TRUSTED_ASSOCIATION.has(comment.author_association)) continue
    const body = comment.body || ''
    for (const match of body.matchAll(/(keep|delete-now)\s*:\s*(\S+)/gi)) {
      const verb = match[1].toLowerCase()
      const branch = match[2].trim()
      if (verb === 'keep') keep.add(branch)
      else deleteNow.add(branch)
    }
  }
  return { keep, deleteNow }
}

function sortObjectByKey (obj) {
  const out = {}
  for (const key of Object.keys(obj).sort()) out[key] = obj[key]
  return out
}

function renderIssueBody (ledger, sections, cfg, now) {
  const lines = []
  lines.push('> Maintained automatically by the branch-cleanup workflow. Do not edit the')
  lines.push('> ledger block below by hand. To keep a branch, comment `keep: <branch>`; to')
  lines.push('> skip its grace period, comment `delete-now: <branch>`.')
  lines.push('')
  lines.push(`Last run: ${now.toISOString()}${cfg.dryRun ? ' (DRY RUN)' : ''}`)
  lines.push('')

  if (sections.deleted.length) {
    lines.push(`## Deleted this run (${sections.deleted.length})`)
    for (const item of sections.deleted) lines.push(`- \`${item.branch}\` — ${item.reason}`)
    lines.push('')
  }
  if (sections.pending.length) {
    lines.push(`## Pending deletion (${sections.pending.length})`)
    for (const item of sections.pending) {
      const remaining = Math.max(0, item.deleteAfterDays).toFixed(1)
      lines.push(`- \`${item.branch}\` — ${item.reason}; ~${remaining} day(s) until deletion`)
    }
    lines.push('')
  }
  if (sections.reprieved.length) {
    lines.push(`## Reprieved since last run (${sections.reprieved.length})`)
    for (const branch of sections.reprieved) lines.push(`- \`${branch}\``)
    lines.push('')
  }
  if (sections.skipped.length) {
    lines.push(`## Skipped (per-run cap reached, ${sections.skipped.length})`)
    for (const item of sections.skipped) lines.push(`- \`${item.branch}\` — ${item.reason}`)
    lines.push('')
  }
  if (ledger.exempt.length) {
    lines.push(`## Exempt (kept by maintainer ack, ${ledger.exempt.length})`)
    for (const branch of ledger.exempt) lines.push(`- \`${branch}\``)
    lines.push('')
  }

  lines.push(LEDGER_BEGIN)
  lines.push('```json')
  lines.push(JSON.stringify({
    version: 1,
    updated: now.toISOString(),
    exempt: [...ledger.exempt].sort(),
    pending: sortObjectByKey(ledger.pending)
  }, null, 2))
  lines.push('```')
  lines.push(LEDGER_END)
  return lines.join('\n')
}

// Whether the repo has Issues enabled (the tracking-issue ledger depends on it).
async function issuesEnabled (github, owner, repo) {
  try {
    const { data } = await github.rest.repos.get({ owner, repo })
    return data.has_issues !== false
  } catch {
    return true // assume enabled; downstream issue ops are still guarded
  }
}

async function findOrCreateIssue (github, owner, repo, body, create) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    labels: LEDGER_LABEL,
    per_page: 100
  })
  // listForRepo includes PRs; exclude them.
  const issue = issues.find((item) => !item.pull_request)
  if (issue) return issue
  if (!create) return null
  try {
    await github.rest.issues.createLabel({ owner, repo, name: LEDGER_LABEL, color: 'ededed' })
  } catch {
    // label already exists
  }
  const { data } = await github.rest.issues.create({
    owner,
    repo,
    title: LEDGER_TITLE,
    labels: [LEDGER_LABEL],
    body
  })
  return data
}

export async function processBranchCleanup ({ github, context, core, env = process.env }) {
  const cfg = readConfig(env)
  const owner = context.repo.owner
  const repo = context.repo.repo
  const now = new Date()
  const nowMs = now.getTime()
  const defaultBranch = context.payload?.repository?.default_branch || 'main'

  core.info(`Branch cleanup for ${owner}/${repo} (dryRun=${cfg.dryRun}, singlePackage=${cfg.singlePackage})`)

  const [branches, tags, openPrs] = await Promise.all([
    github.paginate(github.rest.repos.listBranches, { owner, repo, per_page: 100 }),
    github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 }),
    github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 })
  ])
  core.info(`Found ${branches.length} branch(es), ${tags.length} tag(s), ${openPrs.length} open PR(s)`)

  // Branches that are head (same-repo) or base of an open PR are always active.
  const openPrRefs = new Set()
  for (const pr of openPrs) {
    if (pr.head?.repo?.full_name === `${owner}/${repo}` && pr.head?.ref) openPrRefs.add(pr.head.ref)
    if (pr.base?.ref) openPrRefs.add(pr.base.ref)
  }

  const latestPublished = latestPublishedByPackage(tags, cfg)
  const latestReleaseBranches = new Set()
  for (const [pkg, version] of latestPublished) {
    latestReleaseBranches.add(latestReleaseBranchName(pkg, version, cfg))
  }

  const timestamps = loadBranchTimestamps(cfg.timestampsFile)

  const classified = branches.map((b) => ({
    name: b.name,
    sha: b.commit?.sha,
    protected: Boolean(b.protected),
    info: classifyBranch(b.name, cfg)
  }))

  function safelistReason (branch) {
    if (branch.name === defaultBranch || branch.name === 'main') return 'default branch'
    if (branch.protected) return 'protected branch'
    if (openPrRefs.has(branch.name)) return 'open PR'
    if (WIP_RE.test(branch.name)) return 'WIP flag'
    if (latestReleaseBranches.has(branch.name)) return 'latest published version'
    return null
  }

  // Release eligibility (semver window) for non-safelisted release branches.
  const releaseBranches = classified.filter((b) => b.info.type === 'release' && b.info.version && !b.info.version.prerelease)
  const eligibleReleases = eligibleReleaseBranches(
    releaseBranches.map((b) => ({ name: b.name, package: b.info.package, version: b.info.version })),
    cfg
  )

  const candidates = new Map() // branch name -> reason
  for (const branch of classified) {
    if (safelistReason(branch)) continue
    const { type, version } = branch.info

    if (type === 'release' && version && !version.prerelease) {
      if (eligibleReleases.has(branch.name)) {
        candidates.set(branch.name, `release outside semver window (${branch.info.package === SINGLE_PACKAGE_KEY ? version.raw : branch.info.package + ' ' + version.raw})`)
      }
      continue
    }

    // Prerelease release branches, feature, tmp, ad-hoc -> inactivity based.
    let thresholdDays = cfg.adhocInactivityDays
    let label = 'ad-hoc'
    if (type === 'feature') {
      thresholdDays = cfg.featureInactivityDays
      label = 'feature'
    } else if (type === 'tmp') {
      thresholdDays = cfg.tmpInactivityDays
      label = 'tmp'
    } else if (type === 'release') {
      thresholdDays = cfg.tmpInactivityDays
      label = 'prerelease'
    }

    const commitMs = await lastCommitTimestampMs(github, owner, repo, branch.name, branch.sha, timestamps)
    if (commitMs === null) {
      core.warning(`Skipping ${branch.name}: could not determine last commit date`)
      continue
    }
    let lastActivityMs = commitMs
    const inactiveDaysByCommit = (nowMs - commitMs) / DAY_MS
    if (inactiveDaysByCommit <= thresholdDays) continue // active by commit date

    // Only now (already stale by commit) is it worth a PR lookup to extend activity.
    const prMs = await lastPrActivityMs(github, owner, repo, branch.name)
    if (prMs !== null) lastActivityMs = Math.max(lastActivityMs, prMs)
    const inactiveDays = (nowMs - lastActivityMs) / DAY_MS
    if (inactiveDays > thresholdDays) {
      candidates.set(branch.name, `${label} branch inactive ${inactiveDays.toFixed(0)} day(s) (> ${thresholdDays})`)
    }
  }

  core.info(`Computed ${candidates.size} deletion candidate(s)`)

  // The tracking issue is the durable grace-period ledger. If Issues are disabled in
  // this repo, firstFlagged dates cannot be persisted, so we degrade to report-only
  // (compute + log candidates, never delete) instead of crashing.
  if (!(await issuesEnabled(github, owner, repo))) {
    core.warning('Issues are disabled in this repository. Branch cleanup needs Issues enabled for the grace-period tracking ledger; running in report-only mode (no branches will be deleted).')
    core.summary
      .addHeading('Branch cleanup (report-only — Issues disabled)', 2)
      .addRaw(`${candidates.size} candidate(s); no deletions (no tracking ledger available).\n\n`)
    for (const [branch, reason] of candidates) {
      core.info(`[report-only] candidate: ${branch} — ${reason}`)
      core.summary.addRaw(`- \`${branch}\` — ${reason}\n`)
    }
    await core.summary.write()
    return { candidates: [...candidates.keys()], deleted: [], pending: [], reprieved: [], skipped: [], reportOnly: true }
  }

  // Load ledger + acks from the tracking issue.
  const issue = await findOrCreateIssue(github, owner, repo, '', false)
  const ledger = parseLedger(issue?.body)
  let acks = { keep: new Set(), deleteNow: new Set() }
  if (issue) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issue.number,
      per_page: 100
    })
    acks = parseAcks(comments)
  }

  const exempt = new Set([...ledger.exempt, ...acks.keep])

  // Rebuild pending ledger from current candidates, preserving firstFlagged.
  const newPending = {}
  for (const [branch, reason] of candidates) {
    if (exempt.has(branch)) continue
    const previous = ledger.pending[branch]
    newPending[branch] = {
      firstFlagged: previous?.firstFlagged || now.toISOString(),
      reason
    }
  }

  const reprieved = Object.keys(ledger.pending).filter((b) => !(b in newPending) && !exempt.has(b))

  // Decide deletions: flagged long enough OR delete-now ack.
  const ready = []
  for (const [branch, entry] of Object.entries(newPending)) {
    const flaggedDays = (nowMs - new Date(entry.firstFlagged).getTime()) / DAY_MS
    const graceMet = flaggedDays >= cfg.gracePeriodDays
    if (graceMet || acks.deleteNow.has(branch)) {
      ready.push({ branch, reason: entry.reason, flaggedDays })
    }
  }
  ready.sort((a, b) => b.flaggedDays - a.flaggedDays)

  const toDelete = ready.slice(0, cfg.maxDeletionsPerRun)
  const skipped = ready.slice(cfg.maxDeletionsPerRun).map((item) => ({ branch: item.branch, reason: 'per-run deletion cap reached' }))

  const deleted = []
  for (const item of toDelete) {
    if (cfg.dryRun) {
      deleted.push({ branch: item.branch, reason: `${item.reason} (DRY RUN — not deleted)` })
      continue
    }
    try {
      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${item.branch}` })
      deleted.push({ branch: item.branch, reason: item.reason })
      delete newPending[item.branch]
      core.info(`Deleted ${item.branch}`)
    } catch (error) {
      core.warning(`Failed to delete ${item.branch}: ${error.message}`)
    }
  }

  const pendingSection = Object.entries(newPending).map(([branch, entry]) => {
    const flaggedDays = (nowMs - new Date(entry.firstFlagged).getTime()) / DAY_MS
    return { branch, reason: entry.reason, deleteAfterDays: cfg.gracePeriodDays - flaggedDays }
  }).sort((a, b) => a.deleteAfterDays - b.deleteAfterDays)

  const finalLedger = { version: 1, exempt: [...exempt], pending: newPending }
  const sections = { deleted, pending: pendingSection, reprieved, skipped }
  const body = renderIssueBody(finalLedger, sections, cfg, now)

  const hasState = Object.keys(newPending).length > 0 || deleted.length > 0 || exempt.size > 0 || reprieved.length > 0
  if (!issue && hasState) {
    await findOrCreateIssue(github, owner, repo, body, true)
  } else if (issue) {
    await github.rest.issues.update({ owner, repo, issue_number: issue.number, body })
    const summary = buildRunComment(sections, cfg)
    if (summary) {
      await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: summary })
    }
  }

  core.summary
    .addHeading('Branch cleanup', 2)
    .addRaw(`Mode: ${cfg.dryRun ? 'DRY RUN' : 'enforce'}\n\n`)
    .addRaw(`Candidates: ${candidates.size} | Deleted: ${deleted.length} | Pending: ${pendingSection.length} | Reprieved: ${reprieved.length}\n`)
  await core.summary.write()

  return { candidates: [...candidates.keys()], deleted, pending: pendingSection, reprieved, skipped }
}

function buildRunComment (sections, cfg) {
  if (!sections.deleted.length && !sections.reprieved.length && !sections.skipped.length) return null
  const lines = [`### Branch cleanup run${cfg.dryRun ? ' (DRY RUN)' : ''}`, '']
  if (sections.deleted.length) {
    lines.push(`Deleted ${sections.deleted.length} branch(es):`)
    for (const item of sections.deleted) lines.push(`- \`${item.branch}\` — ${item.reason}`)
    lines.push('')
  }
  if (sections.skipped.length) {
    lines.push(`Skipped ${sections.skipped.length} (per-run cap):`)
    for (const item of sections.skipped) lines.push(`- \`${item.branch}\``)
    lines.push('')
  }
  if (sections.reprieved.length) {
    lines.push(`Reprieved ${sections.reprieved.length} (no longer candidates):`)
    for (const branch of sections.reprieved) lines.push(`- \`${branch}\``)
  }
  return lines.join('\n')
}
