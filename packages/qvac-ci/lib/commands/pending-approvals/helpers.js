'use strict'

// All pending-approvals domain logic.
//
// Secrets (GITHUB_TOKEN, GITHUB_APP_ID, GITHUB_PRIVATE_KEY) are read from
// process.env inside this file — they are never passed as function parameters.
// This prevents secrets from appearing in call stacks or being accidentally
// logged by a caller.

const { Octokit } = require('@octokit/rest')

// --- Error helpers ---
function throwApiError (err, context) {
  let message
  if (err.status === 401) {
    message = 'Authentication failed — check GITHUB_TOKEN / GITHUB_APP_ID / GITHUB_PRIVATE_KEY'
  } else if (err.status === 403) {
    message = context + ' (forbidden — check token scopes and permissions)'
  } else if (err.status === 404) {
    message = context + ' (not found — check the value is correct and the token has access)'
  } else {
    message = context + ': ' + err.message
  }
  const out = new Error(message)
  out.status = err.status
  throw out
}

const ROLE_DISPLAY = {
  maintainer: 'Management',
  teamLead: 'Team Lead',
  other: 'Member'
}

const MIN_CODEOWNER_APPROVALS = 1

function buildOctokit () {
  const token = process.env.GITHUB_TOKEN
  return new Octokit({ auth: token })
}

async function buildAppOctokit (createAppAuth, owner, repo) {
  const appId = parseInt(process.env.GITHUB_APP_ID, 10)
  const privateKey = process.env.GITHUB_PRIVATE_KEY

  const auth = createAppAuth({ appId, privateKey })

  const { token: jwtToken } = await auth({ type: 'app' })
  const appOctokit = new Octokit({ auth: jwtToken })

  let installation
  try {
    const { data } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo })
    installation = data
  } catch (err) {
    throwApiError(err, `GitHub App (ID: ${appId}) does not appear to be installed on ${owner}/${repo}`)
  }

  const { token: installToken } = await auth({ type: 'installation', installationId: installation.id })

  return new Octokit({ auth: installToken })
}

function getLatestApprovals (reviews) {
  const byUser = Object.create(null)
  for (const review of reviews) {
    const username = review.user && review.user.login
    if (!username) continue
    if (!byUser[username] || review.submitted_at > byUser[username].submitted_at) {
      byUser[username] = review
    }
  }
  return Object.values(byUser)
}

function checkApproved (counts, minTotal) {
  const maintainer = counts.maintainer || 0
  const teamLead = counts.teamLead || 0
  const other = counts.other || 0
  const codeowner = maintainer + teamLead
  const total = codeowner + other
  return codeowner >= MIN_CODEOWNER_APPROVALS && total >= minTotal
}

function getPendingMessage (counts, minTotal) {
  const maintainer = counts.maintainer || 0
  const teamLead = counts.teamLead || 0
  const other = counts.other || 0
  const codeowner = maintainer + teamLead
  const total = codeowner + other

  const missingCodeowner = Math.max(0, MIN_CODEOWNER_APPROVALS - codeowner)
  const missingTotal = Math.max(0, minTotal - total)
  const extraNeeded = Math.max(0, missingTotal - missingCodeowner)

  const parts = []
  if (missingCodeowner > 0) parts.push(missingCodeowner + ' Management or Team Lead')
  if (extraNeeded > 0) parts.push(extraNeeded + ' more from Management, Team Lead, or Member')
  return parts.join(', and ')
}

function buildApprovalComment (approved, counts, pendingMessage) {
  const approvalSummary = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([role, count]) => (ROLE_DISPLAY[role] || role) + ': ' + count)
    .join(', ') || 'none'

  const lines = [
    '## Review Status',
    '**Current Status: ' + (approved ? '✅ APPROVED' : '❌ PENDING') + '**',
    'Approvals so far: ' + approvalSummary
  ]

  if (!approved) lines.push('\nPending reviews: Needs ' + pendingMessage + '.')

  return lines.join('\n')
}

async function fetchReviews (octokit, owner, repo, prNumber) {
  try {
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber
    })
    return data
  } catch (err) {
    throwApiError(err, `PR #${prNumber} not found in ${owner}/${repo}`)
  }
}

async function buildApprovalCounts (appOctokit, owner, repo, reviews, teams) {
  const latestApprovals = getLatestApprovals(reviews)
  const approvers = latestApprovals
    .filter(r => r.state === 'APPROVED')
    .map(r => r.user.login)

  if (approvers.length === 0) {
    return { maintainer: 0, teamLead: 0, other: 0 }
  }

  const [maintainerMembers, teamLeadMembers] = await Promise.all([
    getTeamMembers(appOctokit, owner, teams.maintainer),
    getTeamMembers(appOctokit, owner, teams.teamLead)
  ])

  const counts = { maintainer: 0, teamLead: 0, other: 0 }
  for (const login of approvers) {
    if (maintainerMembers.has(login)) {
      counts.maintainer++
    } else if (teamLeadMembers.has(login)) {
      counts.teamLead++
    } else {
      counts.other++
    }
  }

  return counts
}

async function getTeamMembers (octokit, org, teamSlug) {
  try {
    const members = await octokit.paginate(octokit.rest.teams.listMembersInOrg, {
      org,
      team_slug: teamSlug,
      per_page: 100
    })
    return new Set(members.map(m => m.login))
  } catch (err) {
    throwApiError(err, `Team '${teamSlug}' not found in org '${org}'`)
  }
}

async function upsertPrComment (octokit, owner, repo, prNumber, body) {
  const MARKER = '## Review Status'

  let comments
  try {
    comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100
    })
  } catch (err) {
    throwApiError(err, `Could not list comments on PR #${prNumber} in ${owner}/${repo}`)
  }

  const existing = comments.find(c => c.body && c.body.includes(MARKER))

  try {
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body
      })
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body
      })
    }
  } catch (err) {
    throwApiError(err, `Could not post review-status comment on PR #${prNumber} in ${owner}/${repo}`)
  }
}

module.exports = {
  throwApiError,
  buildOctokit,
  buildAppOctokit,
  getLatestApprovals,
  checkApproved,
  getPendingMessage,
  buildApprovalComment,
  fetchReviews,
  buildApprovalCounts,
  getTeamMembers,
  upsertPrComment,
  MIN_CODEOWNER_APPROVALS,
  ROLE_DISPLAY
}
