const STALE_LABEL = 'Stale'
const EXEMPT_LABELS = new Set(['wip', 'do-not-close'])
const DAYS_BEFORE_STALE = 21
const DAYS_BEFORE_CLOSE = 1
const MS_PER_DAY = 24 * 60 * 60 * 1000

const STALE_DRAFT_MESSAGE =
  'This draft PR is stale because it has been open 21 days and the author has not commented since opening. It is flagged for removal. Remove the stale label or comment on the PR or this will be closed in one day.'

const CLOSE_DRAFT_MESSAGE =
  'This draft PR was closed because it has been stalled for 22 days with no author comment since opening. You can reopen this PR later if it is still necessary.'

function daysSince (isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / MS_PER_DAY
}

function hasExemptLabel (labels) {
  return labels.some((label) => EXEMPT_LABELS.has(label.name))
}

function hasStaleLabel (labels) {
  return labels.some((label) => label.name === STALE_LABEL)
}

async function authorHasCommentedOnPr (github, owner, repo, pullNumber, authorLogin) {
  const issueComments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100
  })

  for (const comment of issueComments) {
    if (comment.user?.login === authorLogin) {
      return true
    }
  }

  const reviewComments = await github.paginate(github.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  })

  for (const comment of reviewComments) {
    if (comment.user?.login === authorLogin) {
      return true
    }
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  })

  for (const review of reviews) {
    if (review.user?.login === authorLogin && review.body?.trim()) {
      return true
    }
  }

  return false
}

async function getStaleLabelAppliedAt (github, owner, repo, pullNumber) {
  const events = await github.paginate(github.rest.issues.listEvents, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100
  })

  let latest = null
  for (const event of events) {
    if (event.event !== 'labeled' || event.label?.name !== STALE_LABEL) {
      continue
    }
    if (!latest || new Date(event.created_at) > new Date(latest)) {
      latest = event.created_at
    }
  }

  return latest
}

function logDryRun (core, message) {
  core.info(`[dry-run] ${message}`)
}

export async function processStaleDraftPrs ({ github, context, core, dryRun = false }) {
  const owner = context.repo.owner
  const repo = context.repo.repo

  if (dryRun) {
    core.info('Dry-run mode enabled: no labels, comments, or closures will be applied')
  }

  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100
  })

  const draftPulls = pulls.filter((pull) => pull.draft)

  core.info(`Found ${draftPulls.length} open draft pull request(s) to evaluate`)

  for (const pull of draftPulls) {
    const number = pull.number
    const authorLogin = pull.user?.login

    if (!authorLogin) {
      core.warning(`Skipping PR #${number}: missing author login`)
      continue
    }

    if (hasExemptLabel(pull.labels)) {
      core.info(`Skipping PR #${number}: exempt label present`)
      continue
    }

    if (hasStaleLabel(pull.labels)) {
      const authorCommented = await authorHasCommentedOnPr(github, owner, repo, number, authorLogin)
      if (authorCommented) {
        if (dryRun) {
          logDryRun(core, `Would remove stale label from PR #${number}: author has commented since opening`)
        } else {
          core.info(`Removing stale label from PR #${number}: author has commented since opening`)
          await github.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: number,
            name: STALE_LABEL
          })
        }
        continue
      }

      const staleLabelAppliedAt = await getStaleLabelAppliedAt(github, owner, repo, number)
      if (!staleLabelAppliedAt) {
        core.warning(`Skipping PR #${number}: has stale label but no labeled event found`)
        continue
      }

      if (daysSince(staleLabelAppliedAt) >= DAYS_BEFORE_CLOSE) {
        if (dryRun) {
          logDryRun(core, `Would close stale draft PR #${number}`)
          logDryRun(core, `Would comment on PR #${number}: ${CLOSE_DRAFT_MESSAGE}`)
        } else {
          core.info(`Closing stale draft PR #${number}`)
          await github.rest.issues.createComment({
            owner,
            repo,
            issue_number: number,
            body: CLOSE_DRAFT_MESSAGE
          })
          await github.rest.pulls.update({
            owner,
            repo,
            pull_number: number,
            state: 'closed'
          })
        }
      } else {
        core.info(`Skipping PR #${number}: stale label applied ${daysSince(staleLabelAppliedAt).toFixed(1)} day(s) ago`)
      }
      continue
    }

    if (daysSince(pull.created_at) < DAYS_BEFORE_STALE) {
      core.info(`Skipping PR #${number}: open for ${daysSince(pull.created_at).toFixed(1)} day(s)`)
      continue
    }

    const authorCommented = await authorHasCommentedOnPr(github, owner, repo, number, authorLogin)
    if (authorCommented) {
      core.info(`Skipping PR #${number}: author has commented since opening`)
      continue
    }

    if (dryRun) {
      logDryRun(core, `Would mark draft PR #${number} as stale (no author comments since opening)`)
      logDryRun(core, `Would add label "${STALE_LABEL}" to PR #${number}`)
      logDryRun(core, `Would comment on PR #${number}: ${STALE_DRAFT_MESSAGE}`)
    } else {
      core.info(`Marking draft PR #${number} as stale (no author comments since opening)`)
      await github.rest.issues.addLabels({
        owner,
        repo,
        issue_number: number,
        labels: [STALE_LABEL]
      })
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: STALE_DRAFT_MESSAGE
      })
    }
  }
}
