#!/usr/bin/env node

import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_REPOSITORY = 'tetherto/qvac'
const CONCURRENCY = 6
const REPORT_LIMIT = 10
const GH_OPTIONS = {
  maxBuffer: 50 * 1024 * 1024,
  timeout: 60_000
}
const ACTIVE_STATUSES = new Set(['queued', 'in_progress'])

function parseRepository (repository) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository)
  if (!match) throw new Error(`Invalid repository "${repository}"`)
  return { owner: match[1], repo: match[2] }
}

function parseInput (input, repository) {
  const value = input.trim()
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?\/?(?:[?#].*)?$/.exec(value)
  if (url) {
    return {
      kind: url[4] ? 'job' : 'run',
      owner: url[1],
      repo: url[2],
      runId: Number(url[3]),
      ...(url[4] ? { jobId: Number(url[4]) } : {})
    }
  }

  if (!value || /^https?:\/\//.test(value)) {
    throw new Error('Expected a GitHub Actions job URL, run URL, or runner label')
  }
  return { kind: 'label', ...parseRepository(repository), label: value }
}

function parseArguments (argv) {
  let input = null
  let repository = DEFAULT_REPOSITORY
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--repo') {
      repository = argv[++index]
      if (!repository || repository.startsWith('-')) {
        throw new Error('--repo requires owner/repo')
      }
    } else if (argument === '--json') {
      json = true
    } else if (argument.startsWith('-')) {
      throw new Error(`Unsupported option: ${argument}`)
    } else if (input) {
      throw new Error(`Unexpected argument: ${argument}`)
    } else {
      input = argument
    }
  }

  if (!input) {
    throw new Error(
      'Usage: inspect-runner-queue.mjs <job-url|run-url|runner-label> [--repo owner/repo] [--json]'
    )
  }
  return { input, repository, json }
}

async function ghGet (endpoint, collection = null) {
  try {
    const separator = endpoint.includes('?') ? '&' : '?'
    const url = collection ? `${endpoint}${separator}per_page=100` : endpoint
    const args = ['api', '--method', 'GET']
    if (collection) args.push('--paginate', '--slurp')
    args.push(url)
    const { stdout } = await execFileAsync(
      'gh',
      args,
      GH_OPTIONS
    )
    const response = JSON.parse(stdout)
    if (!collection) return response
    return response.flatMap((page) =>
      collection === true ? page : page[collection]
    )
  } catch (error) {
    const message = `${error.stderr ?? ''}\n${error.message ?? ''}`
    const status = /(?:HTTP|status:)\s*(\d{3})/i.exec(message)
    if (status) error.status = Number(status[1])
    if (error.killed || error.signal === 'SIGTERM') error.code = 'ETIMEDOUT'
    throw error
  }
}

async function mapConcurrent (items, mapper) {
  const results = new Array(items.length)
  let next = 0

  async function worker () {
    while (next < items.length) {
      const index = next++
      results[index] = await mapper(items[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker)
  )
  return results
}

function normalizeLabel (label) {
  return label.toLowerCase()
}

function isSelfHosted (job) {
  return job.labels?.some((label) => {
    const value = normalizeLabel(label)
    return value === 'self-hosted' || value.startsWith('qvac-')
  })
}

function sameLabels (left, right) {
  if (!left || left.length !== right.length) return false
  const expected = new Set(right.map(normalizeLabel))
  return left.every((label) => expected.has(normalizeLabel(label)))
}

function matchesTarget (job, label, targetLabels) {
  if (!isSelfHosted(job)) return false
  if (targetLabels) return sameLabels(job.labels, targetLabels)
  const expected = normalizeLabel(label)
  return job.labels?.some((value) => normalizeLabel(value) === expected)
}

function selectRunTarget (jobs) {
  const active = jobs.filter(
    (job) => ACTIVE_STATUSES.has(job.status) && isSelfHosted(job)
  )
  if (active.length === 0) throw new Error('Run has no active self-hosted jobs')
  if (active.length > 1) {
    const candidates = active
      .map((job) => `${job.html_url}: ${job.name}`)
      .join('\n')
    throw new Error(
      `Run has multiple active self-hosted jobs; provide a job URL:\n${candidates}`
    )
  }
  return active[0]
}

function validateTarget (job, runId) {
  if (job.run_id !== runId) {
    throw new Error(`Job ${job.id} does not belong to run ${runId}`)
  }
  if (!isSelfHosted(job)) throw new Error(`Job ${job.id} is not self-hosted`)
  return job
}

function displayLabel (labels) {
  const qvac = labels.filter((label) =>
    normalizeLabel(label).startsWith('qvac-')
  )
  return qvac.length === 1 ? qvac[0] : labels.join(' + ')
}

async function resolveTarget (parsed) {
  if (parsed.kind === 'label') {
    return { label: parsed.label, target: null, targetLabels: null }
  }

  const target = parsed.kind === 'job'
    ? await ghGet(`repos/${parsed.owner}/${parsed.repo}/actions/jobs/${parsed.jobId}`)
    : selectRunTarget(
      await ghGet(
        `repos/${parsed.owner}/${parsed.repo}/actions/runs/${parsed.runId}/jobs?filter=latest`,
        'jobs'
      )
    )
  validateTarget(target, parsed.runId)
  return {
    label: displayLabel(target.labels ?? []),
    target,
    targetLabels: target.labels ?? []
  }
}

async function resolvePullRequest (run, owner, repo) {
  const number = run.pull_requests?.find(
    (pull) => pull.head?.ref === run.head_branch
  )?.number
  if (number) {
    try {
      return await ghGet(`repos/${owner}/${repo}/pulls/${number}`)
    } catch {}
  }

  if (!run.event?.startsWith('pull_request')) return null
  const sourceOwner =
    run.head_repository?.owner?.login ??
    run.head_repository?.full_name?.split('/')[0]
  if (!sourceOwner || !run.head_branch) return null

  try {
    const head = encodeURIComponent(`${sourceOwner}:${run.head_branch}`)
    const pulls = await ghGet(
      `repos/${owner}/${repo}/pulls?state=all&head=${head}`,
      true
    )
    const repository = run.head_repository?.full_name?.toLowerCase()
    const matches = pulls.filter((pull) =>
      pull.head?.ref === run.head_branch &&
      (!repository ||
        pull.head?.repo?.full_name?.toLowerCase() === repository)
    )
    return matches.find((pull) => pull.head?.sha === run.head_sha) ??
      matches[0] ??
      null
  } catch {
    return null
  }
}

function runContext (run, pull) {
  const source = pull?.head?.repo ?? run.head_repository
  return {
    event: run.event ?? null,
    actor: run.actor?.login ?? null,
    sourceRepository: source
      ? { fullName: source.full_name, htmlUrl: source.html_url }
      : null,
    pullRequest: pull
      ? {
          number: pull.number,
          title: pull.title,
          htmlUrl: pull.html_url,
          author: pull.user?.login ?? null
        }
      : null
  }
}

async function inspectQueue (parsed) {
  const { label, target, targetLabels } = await resolveTarget(parsed)
  const [queued, running] = await Promise.all([
    ghGet(
      `repos/${parsed.owner}/${parsed.repo}/actions/runs?status=queued`,
      'workflow_runs'
    ),
    ghGet(
      `repos/${parsed.owner}/${parsed.repo}/actions/runs?status=in_progress`,
      'workflow_runs'
    )
  ])
  const runs = [
    ...new Map([...queued, ...running].map((run) => [run.id, run])).values()
  ]
  const jobGroups = await mapConcurrent(runs, (run) =>
    ghGet(
      `repos/${parsed.owner}/${parsed.repo}/actions/runs/${run.id}/jobs?filter=latest`,
      'jobs'
    )
  )
  const records = runs
    .map((run, index) => ({ run, jobs: jobGroups[index] }))
    .filter(({ jobs }) =>
      jobs.some((job) => matchesTarget(job, label, targetLabels))
    )
  const matchedGroups = await mapConcurrent(records, async ({ run, jobs }) => {
    const pull = await resolvePullRequest(run, parsed.owner, parsed.repo)
    const context = runContext(run, pull)
    return jobs
      .filter((job) => matchesTarget(job, label, targetLabels))
      .map((job) => ({ ...job, run: context }))
  })
  const matched = matchedGroups.flat()
  const activeTarget = target
    ? matched.find((job) => job.id === target.id)
    : null
  const canonicalTarget = activeTarget ?? target
  const generatedAt = new Date()
  const runningJobs = matched
    .filter((job) => job.status === 'in_progress')
    .sort((left, right) =>
      new Date(left.started_at ?? left.created_at) -
      new Date(right.started_at ?? right.created_at)
    )
  const queuedJobs = matched
    .filter((job) => job.status === 'queued')
    .sort((left, right) =>
      new Date(left.created_at) - new Date(right.created_at) ||
      left.id - right.id
    )
  const targetIndex = canonicalTarget
    ? queuedJobs.findIndex((job) => job.id === canonicalTarget.id)
    : -1

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    label,
    generatedAt,
    running: runningJobs,
    queued: queuedJobs,
    targetJobId: canonicalTarget?.id ?? null,
    targetPosition: targetIndex >= 0 ? targetIndex + 1 : null,
    jobsAhead: targetIndex >= 0 ? targetIndex : null,
    target: canonicalTarget
  }
}

function formatDuration (milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function markdownText (value) {
  return `${value ?? ''}`
    .replaceAll('\\', '\\\\')
    .replace(/([*_[\]<>])/g, '\\$1')
}

function markdownCode (value) {
  const text = `${value ?? ''}`
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  )
  const delimiter = '`'.repeat(longest + 1)
  return `${delimiter}${longest ? ` ${text} ` : text}${delimiter}`
}

function markdownLink (url, text) {
  return `[${markdownText(text)}](${url})`
}

function encodePath (value) {
  return value
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) =>
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/')
}

function branchLink (job, snapshot) {
  if (!job.head_branch) return null
  const source = job.run?.sourceRepository
  const baseName = `${snapshot.owner}/${snapshot.repo}`
  const fullName = source?.fullName ?? baseName
  const owner = fullName.split('/')[0]
  const text = fullName.toLowerCase() === baseName.toLowerCase()
    ? job.head_branch
    : `${owner}:${job.head_branch}`
  const root = source ? source.htmlUrl : `https://github.com/${baseName}`
  return root
    ? markdownLink(`${root}/tree/${encodePath(job.head_branch)}`, text)
    : markdownCode(text)
}

function card (job, index, snapshot, status) {
  const pull = job.run?.pullRequest
  const title = pull
    ? markdownLink(
      pull.htmlUrl,
      `PR #${pull.number} · ${pull.title}`
    )
    : markdownText(job.workflow_name)
  const actor = pull?.author ?? job.run?.actor
  const context = job.run?.event
    ? `${markdownCode(job.run.event)}${actor ? ` by ${markdownCode(`@${actor}`)}` : ''}`
    : actor
      ? `by ${markdownCode(`@${actor}`)}`
      : null
  const started = status === 'Running'
    ? job.started_at ?? job.created_at
    : job.created_at
  const duration = formatDuration(
    snapshot.generatedAt.getTime() - new Date(started).getTime()
  )
  const branch = branchLink(job, snapshot)
  const metadata = [
    branch ? `🌿 ${branch}` : null,
    markdownLink(job.html_url, 'Open job ↗'),
    job.runner_name ? `🖥️ ${markdownCode(job.runner_name)}` : null
  ].filter(Boolean)
  const lines = [
    `### ${index}. ${title}`,
    ...(context ? [context] : []),
    '',
    `**${status} · ${duration}**${job.id === snapshot.targetJobId ? ' · **Target**' : ''}`
  ]
  if (pull) lines.push('', `Workflow: ${markdownCode(job.workflow_name)}`)
  lines.push(`Job: ${markdownCode(job.name)}`, metadata.join(' · '))
  return lines
}

function section (title, jobs, snapshot, status) {
  const lines = ['', `## ${title}`]
  if (!jobs.length) {
    lines.push(status === 'Running' ? '_No jobs running_' : '_No jobs waiting_')
    return lines
  }
  if (status === 'Queued') lines.push('_Estimated oldest-first_')
  jobs.slice(0, REPORT_LIMIT).forEach((job, index) => {
    lines.push('', ...card(job, index + 1, snapshot, status))
  })
  if (jobs.length > REPORT_LIMIT) {
    lines.push('', `… ${jobs.length - REPORT_LIMIT} more jobs omitted`)
  }
  return lines
}

function formatReport (snapshot) {
  const lines = [
    '# 🖥️ Runner queue',
    markdownCode(snapshot.label),
    '',
    `🟢 **${snapshot.running.length} running** · ⏳ **${snapshot.queued.length} queued**`,
    `Repository: ${markdownLink(`https://github.com/${snapshot.owner}/${snapshot.repo}`, `${snapshot.owner}/${snapshot.repo}`)} · Snapshot: ${markdownCode(`${snapshot.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`)}`,
    ...section('▶️ Running', snapshot.running, snapshot, 'Running'),
    ...section('⏳ Queued', snapshot.queued, snapshot, 'Queued')
  ]

  if (snapshot.targetPosition) {
    lines.push(
      '',
      `Target position: estimated #${snapshot.targetPosition} (${snapshot.jobsAhead} matching job${snapshot.jobsAhead === 1 ? '' : 's'} ahead)`
    )
  } else if (
    snapshot.target &&
    !snapshot.running.some((job) => job.id === snapshot.target.id) &&
    !snapshot.queued.some((job) => job.id === snapshot.target.id)
  ) {
    const conclusion = snapshot.target.conclusion
      ? ` (${snapshot.target.conclusion})`
      : ''
    lines.push(
      '',
      `Target job: ${snapshot.target.status}${conclusion} · ${markdownLink(snapshot.target.html_url, 'Open job ↗')}`
    )
  }

  lines.push(
    '',
    '> Repository-scoped snapshot. Running order is oldest-started first; queued order is estimated from `created_at`. GitHub exposes neither authoritative FIFO order nor ETA.'
  )
  return lines.join('\n')
}

function cliError (error) {
  if (error.code === 'ENOENT') return 'GitHub CLI is not installed'
  if (error.code === 'ETIMEDOUT') return 'GitHub API request timed out'
  if (error.status === 401) return 'GitHub CLI is not authenticated'
  if (error.status === 403) return 'GitHub API access denied'
  return error.message
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const parsed = parseInput(options.input, options.repository)
  const snapshot = await inspectQueue(parsed)
  const output = options.json
    ? JSON.stringify(snapshot, null, 2)
    : formatReport(snapshot)
  process.stdout.write(`${output}\n`)
}

main().catch((error) => {
  process.stderr.write(`Error: ${cliError(error)}\n`)
  process.exitCode = 1
})
