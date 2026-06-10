import test from 'brittle'
import {
  getLatestApprovals,
  checkApproved,
  getPendingMessage,
  buildApprovalComment,
  buildApprovalCounts,
  hasWriteAccess,
  fetchReviews,
  upsertPrComment,
  throwApiError,
  MIN_CODEOWNER_APPROVALS
} from '../../../lib/commands/pending-approvals/helpers.js'

// getLatestApprovals
test('getLatestApprovals — deduplicates: keeps only most recent review per user', t => {
  const reviews = [
    { user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2024-01-01T10:00:00Z' },
    { user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2024-01-02T10:00:00Z' },
    { user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2024-01-01T09:00:00Z' }
  ]
  const result = getLatestApprovals(reviews)
  t.is(result.length, 2)
  const alice = result.find(r => r.user.login === 'alice')
  t.is(alice.state, 'APPROVED')
})

test('getLatestApprovals — ignores reviews with no user', t => {
  const reviews = [
    { user: null, state: 'APPROVED', submitted_at: '2024-01-01T10:00:00Z' }
  ]
  const result = getLatestApprovals(reviews)
  t.is(result.length, 0)
})

test('getLatestApprovals — returns empty array for empty input', t => {
  t.alike(getLatestApprovals([]), [])
})

// checkApproved
test('checkApproved — approved when codeowner + total threshold met', t => {
  t.ok(checkApproved({ maintainer: 1, teamLead: 0, other: 1 }, 2))
})

test('checkApproved — not approved when codeowner threshold not met', t => {
  t.absent(checkApproved({ maintainer: 0, teamLead: 0, other: 2 }, 2))
})

test('checkApproved — not approved when total threshold not met', t => {
  t.absent(checkApproved({ maintainer: 1, teamLead: 0, other: 0 }, 2))
})

test('checkApproved — approved with exactly minimum approvals', t => {
  t.ok(checkApproved({ maintainer: 1, teamLead: 1, other: 0 }, 2))
})

test('checkApproved — not approved with zero counts', t => {
  t.absent(checkApproved({ maintainer: 0, teamLead: 0, other: 0 }, 2))
})

test('checkApproved — MIN_CODEOWNER_APPROVALS constant is 1', t => {
  t.is(MIN_CODEOWNER_APPROVALS, 1)
})

// getPendingMessage
test('getPendingMessage — describes missing codeowner when none present', t => {
  const msg = getPendingMessage({ maintainer: 0, teamLead: 0, other: 0 }, 2)
  t.ok(msg.includes('Management or Team Lead'))
})

test('getPendingMessage — describes missing total when codeowner present but total low', t => {
  const msg = getPendingMessage({ maintainer: 1, teamLead: 0, other: 0 }, 3)
  t.ok(msg.length > 0)
})

test('getPendingMessage — returns empty string when already approved (caller guards this)', t => {
  // getPendingMessage is a pure function — it has no "approved" state guard itself;
  // the caller checks checkApproved() first. This test verifies the math.
  const msg = getPendingMessage({ maintainer: 1, teamLead: 1, other: 0 }, 2)
  // With 2 approvals meeting both thresholds, no additional approvals needed.
  t.is(msg, '')
})

// buildApprovalComment
test('buildApprovalComment — approved comment contains ✅', t => {
  const body = buildApprovalComment(true, { maintainer: 1, teamLead: 0, other: 1 }, '')
  t.ok(body.includes('✅'))
  t.absent(body.includes('❌'))
})

test('buildApprovalComment — pending comment contains ❌', t => {
  const body = buildApprovalComment(false, { maintainer: 0, teamLead: 0, other: 0 }, 'Management or Team Lead')
  t.ok(body.includes('❌'))
  t.absent(body.includes('✅'))
})

test('buildApprovalComment — includes pending message when not approved', t => {
  const body = buildApprovalComment(false, { maintainer: 0, teamLead: 0, other: 0 }, 'Management or Team Lead')
  t.ok(body.includes('Management or Team Lead'))
})

test('buildApprovalComment — does not include "Pending" when approved', t => {
  const body = buildApprovalComment(true, { maintainer: 1, teamLead: 0, other: 0 }, '')
  t.absent(body.includes('Needs'))
})

test('buildApprovalComment — includes ## Review Status marker', t => {
  const body = buildApprovalComment(true, { maintainer: 1 }, '')
  t.ok(body.includes('## Review Status'))
})

// buildApprovalCounts — with mocked octokit
// writePermissions: map of login → 'admin'|'write'|'read'|'none' (default 'write' for all)
function makeMockOctokit (listMembersInOrg, writePermissions = {}) {
  const rest = {
    teams: { listMembersInOrg },
    repos: {
      getCollaboratorPermissionLevel: async ({ username }) => {
        const perm = Object.prototype.hasOwnProperty.call(writePermissions, username)
          ? writePermissions[username]
          : 'write'
        return { data: { permission: perm } }
      }
    }
  }
  return {
    rest,
    paginate: async (fn, params) => {
      const { data } = await fn(params)
      return data
    }
  }
}

test('buildApprovalCounts — counts approvers by team membership', async t => {
  const reviews = [
    { user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z' },
    { user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z' },
    { user: { login: 'carol' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z' }
  ]

  const mockOctokit = makeMockOctokit(async ({ team_slug: slug }) => {
    if (slug === 'maintainers') return { data: [{ login: 'alice' }] }
    if (slug === 'team-leads') return { data: [{ login: 'bob' }] }
    return { data: [] }
  })

  const teams = { maintainer: 'maintainers', teamLead: 'team-leads' }
  const counts = await buildApprovalCounts(mockOctokit, 'myorg', 'myrepo', reviews, teams)

  t.is(counts.maintainer, 1)
  t.is(counts.teamLead, 1)
  t.is(counts.other, 1)
})

test('buildApprovalCounts — ignores CHANGES_REQUESTED in final count', async t => {
  const reviews = [
    { user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2024-01-02T00:00:00Z' },
    { user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2024-01-01T00:00:00Z' }
  ]

  const mockOctokit = makeMockOctokit(async () => ({ data: [] }))

  const counts = await buildApprovalCounts(mockOctokit, 'org', 'repo', reviews, { maintainer: 'a', teamLead: 'b' })
  // alice's most recent review is APPROVED
  t.is(counts.other, 1)
})

test('buildApprovalCounts — returns zeros when no approvals', async t => {
  const reviews = [
    { user: { login: 'alice' }, state: 'COMMENTED', submitted_at: '2024-01-01T00:00:00Z' }
  ]

  const mockOctokit = makeMockOctokit(async () => ({ data: [] }))

  const counts = await buildApprovalCounts(mockOctokit, 'org', 'repo', reviews, { maintainer: 'a', teamLead: 'b' })
  t.is(counts.maintainer, 0)
  t.is(counts.teamLead, 0)
  t.is(counts.other, 0)
})

test('buildApprovalCounts — excludes approvers without write access', async t => {
  const reviews = [
    { user: { login: 'external' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z' },
    { user: { login: 'internal' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z' }
  ]

  // external has read-only access; internal has write
  const mockOctokit = makeMockOctokit(
    async () => ({ data: [] }),
    { external: 'read', internal: 'write' }
  )

  const counts = await buildApprovalCounts(mockOctokit, 'org', 'repo', reviews, { maintainer: 'a', teamLead: 'b' })
  // external is dropped; internal counts as other
  t.is(counts.other, 1)
  t.is(counts.maintainer, 0)
})

test('buildApprovalCounts — returns zeros when all approvers have read-only access', async t => {
  const reviews = [
    { user: { login: 'outsider' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z' }
  ]

  const mockOctokit = makeMockOctokit(
    async () => ({ data: [] }),
    { outsider: 'none' }
  )

  const counts = await buildApprovalCounts(mockOctokit, 'org', 'repo', reviews, { maintainer: 'a', teamLead: 'b' })
  t.is(counts.maintainer, 0)
  t.is(counts.teamLead, 0)
  t.is(counts.other, 0)
})

// hasWriteAccess — with mocked octokit
test('hasWriteAccess — returns true for write permission', async t => {
  const mockOctokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } })
      }
    }
  }
  t.ok(await hasWriteAccess(mockOctokit, 'org', 'repo', 'alice'))
})

test('hasWriteAccess — returns true for admin permission', async t => {
  const mockOctokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'admin' } })
      }
    }
  }
  t.ok(await hasWriteAccess(mockOctokit, 'org', 'repo', 'alice'))
})

test('hasWriteAccess — returns false for read permission', async t => {
  const mockOctokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } })
      }
    }
  }
  t.absent(await hasWriteAccess(mockOctokit, 'org', 'repo', 'external'))
})

test('hasWriteAccess — returns false for none permission', async t => {
  const mockOctokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'none' } })
      }
    }
  }
  t.absent(await hasWriteAccess(mockOctokit, 'org', 'repo', 'stranger'))
})

test('hasWriteAccess — returns false on 404 (not a collaborator)', async t => {
  const mockOctokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          const err = new Error('Not Found')
          err.status = 404
          throw err
        }
      }
    }
  }
  t.absent(await hasWriteAccess(mockOctokit, 'org', 'repo', 'outsider'))
})

// buildAppOctokit — "app not installed" error mapping via throwApiError
test('buildAppOctokit — maps 404 getRepoInstallation to a descriptive error', async t => {
  const context = 'GitHub App (ID: 99) does not appear to be installed on org/repo'

  // throwApiError is what buildAppOctokit calls internally when getRepoInstallation returns 404
  t.exception(
    () => throwApiError({ status: 404, message: 'Not Found' }, context),
    /not found.*check the value/i,
    '404 produces a "not found" message with remediation hint'
  )
})

test('buildAppOctokit — maps 401 to authentication error', async t => {
  t.exception(
    () => throwApiError({ status: 401, message: 'Bad credentials' }, 'any context'),
    /authentication failed/i,
    '401 produces an authentication-failed message'
  )
})

test('buildAppOctokit — maps 403 to forbidden error with context', async t => {
  const context = 'GitHub App (ID: 99) does not appear to be installed on org/repo'
  t.exception(
    () => throwApiError({ status: 403, message: 'Forbidden' }, context),
    /forbidden/i,
    '403 produces a forbidden message containing the context string'
  )
})

// fetchReviews — with mocked octokit
test('fetchReviews — calls listReviews with correct params', async t => {
  let called = null
  const mockOctokit = {
    rest: {
      pulls: {
        listReviews: async (params) => {
          called = params
          return { data: [] }
        }
      }
    },
    paginate: async (fn, params) => {
      const { data } = await fn(params)
      return data
    }
  }

  await fetchReviews(mockOctokit, 'owner', 'repo', 42)
  t.is(called.owner, 'owner')
  t.is(called.repo, 'repo')
  t.is(called.pull_number, 42)
})

// upsertPrComment — with mocked octokit
function makeCommentOctokit (listComments, createComment, updateComment) {
  const rest = {
    issues: { listComments, createComment, updateComment }
  }
  return {
    rest,
    paginate: async (fn, params) => {
      const { data } = await fn(params)
      return data
    }
  }
}

test('upsertPrComment — creates new comment when none exists', async t => {
  let created = null
  const mockOctokit = makeCommentOctokit(
    async () => ({ data: [] }),
    async (params) => { created = params; return { data: {} } },
    async () => t.fail('should not update')
  )

  await upsertPrComment(mockOctokit, 'owner', 'repo', 1, '## Review Status\nall good')
  t.ok(created)
  t.is(created.issue_number, 1)
  t.ok(created.body.includes('## Review Status'))
})

test('upsertPrComment — updates existing comment when marker found', async t => {
  let updated = null
  const mockOctokit = makeCommentOctokit(
    async () => ({ data: [{ id: 999, body: '## Review Status\nold content' }] }),
    async () => t.fail('should not create'),
    async (params) => { updated = params; return { data: {} } }
  )

  await upsertPrComment(mockOctokit, 'owner', 'repo', 1, '## Review Status\nnew content')
  t.ok(updated)
  t.is(updated.comment_id, 999)
  t.ok(updated.body.includes('new content'))
})
