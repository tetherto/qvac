#!/usr/bin/env node
/**
 * Approve every pending `fork-ci` deployment for a fork PR's head commit.
 *
 * GitHub scopes environment approval to a single workflow run, and a fork PR
 * that touches several packages spreads across many runs — 7 is typical here.
 * All of those encode one decision ("is this commit safe to run with secrets"),
 * which is per-SHA, so clicking through each run costs the approver minutes and
 * buys no additional safety.
 *
 * This changes only the clicking. GitHub still enforces required-reviewer
 * membership and prevent_self_review server-side, so this can do nothing the
 * operator could not do by hand in the Actions UI.
 *
 * Dry run by default. `--yes` additionally requires `--sha` naming the commit
 * you reviewed: the head SHA is resolved at invocation time, so without that
 * pin a push landing between your review and your approval would be approved
 * sight-unseen. The dry run prints the exact pinned command to run next.
 *
 *   node scripts/ci/approve-fork-ci.mjs 3510
 *   node scripts/ci/approve-fork-ci.mjs 3510 --sha c969e50dd... --yes
 */
import { spawnSync } from 'node:child_process'

const REPO = process.env.QVAC_REPO || 'tetherto/qvac'
const ENVIRONMENT = 'fork-ci'

export function parseArgs(argv) {
  const args = { pr: null, sha: null, confirmed: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes') args.confirmed = true
    else if (arg === '--sha') args.sha = argv[++i] ?? null
    else if (/^\d+$/.test(arg)) args.pr = arg
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/**
 * Gate on the operator having named the commit they reviewed. Returns an error
 * string rather than throwing so the caller can print it alongside context.
 */
export function checkApprovalPin({ requestedSha, currentSha, confirmed }) {
  if (!confirmed) return null
  if (!requestedSha) {
    return '--yes requires --sha <commit> naming the commit you reviewed.'
  }
  if (!currentSha.startsWith(requestedSha)) {
    return (
      `refusing to approve: --sha ${requestedSha} does not match the current head ` +
      `${currentSha}. The fork pushed after you reviewed it — re-review the new commit.`
    )
  }
  return null
}

function gh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  }
  return res.stdout.trim()
}

function ghJson(args) {
  const out = gh(args)
  return out ? JSON.parse(out) : null
}

function collectPending(sha) {
  const runs =
    ghJson([
      'api', `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`,
      '--jq', '[.workflow_runs[] | {id, name}]',
    ]) ?? []

  const pending = []
  for (const run of runs) {
    const deployments =
      ghJson([
        'api', `repos/${REPO}/actions/runs/${run.id}/pending_deployments`,
        '--jq',
        `[.[] | select(.environment.name == "${ENVIRONMENT}")
              | {envId: .environment.id, canApprove: .current_user_can_approve}]`,
      ]) ?? []
    for (const deployment of deployments) pending.push({ ...run, ...deployment })
  }
  return pending
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.pr) {
    console.error('usage: approve-fork-ci.mjs <pr-number> [--sha <commit>] [--yes]')
    process.exit(2)
  }

  const meta = ghJson([
    'pr', 'view', args.pr, '--repo', REPO,
    '--json', 'headRefOid,isCrossRepository,headRepositoryOwner,title',
  ])

  if (!meta.isCrossRepository) {
    console.log(`PR #${args.pr} is not from a fork — ${ENVIRONMENT} approval does not apply.`)
    return
  }

  const sha = meta.headRefOid
  const pinError = checkApprovalPin({
    requestedSha: args.sha,
    currentSha: sha,
    confirmed: args.confirmed,
  })
  if (pinError) {
    console.error(pinError)
    process.exit(1)
  }

  console.log(`PR #${args.pr} — ${meta.title}`)
  console.log(`fork: ${meta.headRepositoryOwner.login}`)
  console.log(`head: ${sha}\n`)

  const pending = collectPending(sha)
  if (pending.length === 0) {
    console.log(`No pending ${ENVIRONMENT} deployments on this commit — nothing to approve.`)
    return
  }

  console.log(`${pending.length} pending ${ENVIRONMENT} deployment(s):`)
  for (const item of pending) {
    console.log(`  ${item.canApprove ? '•' : '✗'} ${item.name}  (run ${item.id})`)
  }

  // Approve all or none: a partial approval leaves the PR in a state where some
  // privileged jobs ran and some silently did not, which reads as "tested".
  const blocked = pending.filter((item) => !item.canApprove)
  if (blocked.length) {
    console.error(
      `\n${blocked.length} of these cannot be approved by you — you are not a required ` +
        'reviewer on fork-ci, or this is your own run (self-review is blocked). Nothing approved.',
    )
    process.exit(1)
  }

  if (!args.confirmed) {
    console.log(`\nReview the diff first: https://github.com/${REPO}/pull/${args.pr}/files`)
    console.log('Approval authorises this exact commit to run with secrets on our runners.\n')
    console.log('Then run:')
    console.log(`  node scripts/ci/approve-fork-ci.mjs ${args.pr} --sha ${sha} --yes`)
    return
  }

  for (const item of pending) {
    gh([
      'api', `repos/${REPO}/actions/runs/${item.id}/pending_deployments`,
      '--method', 'POST',
      '-F', `environment_ids[]=${item.envId}`,
      '-f', 'state=approved',
      '-f', `comment=Approved for ${sha.slice(0, 9)} via approve-fork-ci`,
    ])
    console.log(`approved: ${item.name} (run ${item.id})`)
  }

  console.log(`\nApproved ${pending.length} run(s) for ${sha.slice(0, 9)}.`)
  console.log('The next push to this PR invalidates the approval and needs a fresh one.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (e) {
    console.error(`approve-fork-ci: ${e.message}`)
    process.exit(1)
  }
}
