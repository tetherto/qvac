import { command, flag, summary, footer } from 'paparam'
import { Command } from '../../command.js'
import { validatePrNumber, validateRepo, validateTeamSlug, exitWithError } from '../../helpers.js'
// Imported as a namespace so tests can inject mocks via the shared module object.
import { helpers } from './helpers.js'

class PendingApprovals extends Command {
  constructor () {
    super({
      name: 'pending-approvals',
      description: 'Check PR approval status and post a review-status comment',
      secrets: [
        { envVar: 'GITHUB_TOKEN', description: 'GitHub token for comment posting' },
        { envVar: 'GITHUB_APP_ID', description: 'App ID for team membership resolution' },
        { envVar: 'GITHUB_PRIVATE_KEY', description: 'App private key for team membership resolution' }
      ],
      sanitizer: new helpers.GitHubSanitizer()
    })
  }

  toCommand () {
    const cmd = command(
      'pending-approvals',
      summary(this.description),
      flag('--pr-number <number>', 'PR number to check (required)'),
      flag('--repo [owner/repo]', 'owner/repo — falls back to $GITHUB_REPOSITORY'),
      flag('--maintainers-team <slug>', 'GitHub team slug for maintainers/management (required)'),
      flag('--team-leads-team <slug>', 'GitHub team slug for team leads (required)'),
      flag('--min-approvals <n>', 'Minimum total approvals required (default: 2)'),
      footer(this._secretsFooter()),
      async () => {
        try {
          await this.run(cmd.flags)
        } catch (err) {
          exitWithError(this.sanitizer.sanitizeError(err))
        }
      }
    )
    return cmd
  }

  async _run (flags) {
    const prNumber = validatePrNumber(flags['pr-number'] || flags.prNumber)
    const { owner, repo } = validateRepo(
      flags.repo || process.env.GITHUB_REPOSITORY
    )

    const maintainersTeam = validateTeamSlug(
      flags['maintainers-team'] || flags.maintainersTeam, '--maintainers-team'
    )
    const teamLeadsTeam = validateTeamSlug(
      flags['team-leads-team'] || flags.teamLeadsTeam, '--team-leads-team'
    )
    const minApprovals = parseInt(flags['min-approvals'] || flags.minApprovals || '2', 10)
    if (isNaN(minApprovals) || minApprovals < 1) {
      throw new RangeError('--min-approvals must be a positive integer, got: ' + String(flags['min-approvals'] || flags.minApprovals))
    }

    const teams = {
      maintainer: maintainersTeam,
      teamLead: teamLeadsTeam
    }

    const commentOctokit = await helpers.buildOctokit()
    const appOctokit = await helpers.buildAppOctokit(owner, repo)

    const reviews = await helpers.fetchReviews(commentOctokit, owner, repo, prNumber)
    const counts = await helpers.buildApprovalCounts(appOctokit, owner, repo, reviews, teams)

    const approved = helpers.checkApproved(counts, minApprovals)
    const pendingMessage = approved ? '' : helpers.getPendingMessage(counts, minApprovals)
    const commentBody = helpers.buildApprovalComment(approved, counts, pendingMessage)

    await helpers.upsertPrComment(commentOctokit, owner, repo, prNumber, commentBody)

    if (!approved) {
      process.stdout.write('PR #' + prNumber + ' is pending approval: ' + pendingMessage + '\n')
    }
  }
}

export default new PendingApprovals()
