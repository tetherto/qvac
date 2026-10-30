// sdk-scheduled-checks.yml's tracking issues: for each failed scheduled check, comment on its open issue or open one.
// Called from actions/github-script with the jobs' results in NEEDS.

const runUrl = (context) =>
  `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`

const CHECKS = {
  'sdk-install': (url) => ({
    title: 'SDK install-check failing on public npm',
    label: 'npm-visibility',
    // As main's check matched it: the first open issue with the label.
    byLabelOnly: true,
    body: [
      `Scheduled SDK install-check failed.`,
      ``,
      `- Run: ${url}`,
      `- Triage: open the failed run; the install log identifies the offending \`@qvac/*\` package.`,
      `- Likely cause: package was re-published as private, or a release PR to \`release-*\` did not land, leaving \`packages/sdk/package.json\` pinned to a range that npm cannot resolve.`,
      `- Fix: re-publish from the appropriate \`release-*\` branch with public access (\`publish-library-to-npm\` action, see \`docs/gitflow.md\`).`
    ]
  }),
  'openclaw-compat': (url) => ({
    title: 'OpenClaw upstream compatibility smoke failing',
    label: 'github_actions',
    body: [
      `Scheduled OpenClaw upstream compatibility smoke failed.`,
      ``,
      `- Run: ${url}`,
      `- Artifact: \`openclaw-upstream-compat\``,
      `- Triage: read \`prompt-surface.md\` **first** — it reports the advertised tool count and prompt size. The smoke denies every tool, so any count at all means the deny stopped applying; the ceiling is what turns that into a red run.`,
      `- Then diff \`versions.md\` against the last passing run's artifact. If no package version moved, this is not upstream drift — look at \`openclaw-agent.stderr\` (turn count, \`failover decision\` lines), \`sessions/\`, and \`qvac-serve.stdout\`/\`qvac-serve.stderr\`.`,
      `- Possible causes, in the order worth checking: the deny no longer applying (see above, and check \`openclaw-config.json\` for what landed); a version bump visible in \`versions.md\`; a wedged \`qvac serve\` that stops answering mid-run; or the agent turn itself — read \`openclaw-agent.attempt-1.stdout\`, \`toolSummary\` in particular.`,
      `- To reproduce, dispatch this workflow; \`agent_prompt\`, \`tool_profile\` and \`tool_deny\` vary the turn without a code change. \`tool_deny: []\` with \`tool_profile: coding\` restores the pre-#4112 tool surface — deny wins, so both are needed.`
    ]
  }),
  'opencode-compat': (url) => ({
    title: 'OpenCode upstream compatibility smoke failing',
    label: 'github_actions',
    body: [
      `Scheduled OpenCode upstream compatibility smoke failed.`,
      ``,
      `- Run: ${url}`,
      `- Artifact: \`opencode-upstream-compat\``,
      `- Triage: inspect package versions, \`opencode-run.stderr\`, \`opencode-run.jsonl\`, and \`qvac-host.log\` from the artifact.`,
      `- Likely cause: latest \`opencode-ai\` changed plugin/provider behavior, request shape, model handling, or runtime assumptions that the latest published \`@qvac/opencode-plugin\` no longer satisfies.`
    ]
  })
}

module.exports = async ({ github, context, core }) => {
  const needs = JSON.parse(process.env.NEEDS)
  for (const [job, make] of Object.entries(CHECKS)) {
    if (needs[job]?.result !== 'failure') continue
    const { title, label, body, byLabelOnly } = make(runUrl(context))
    const { owner, repo } = context.repo
    const issues = await github.paginate(github.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'open',
      labels: label,
      per_page: 100
    })
    const existing = byLabelOnly
      ? issues[0]
      : issues.find((i) => i.pull_request === undefined && i.title === title)
    if (existing) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: existing.number,
        body: body.join('\n')
      })
      core.info(`${job}: appended comment to existing issue #${existing.number}`)
    } else {
      const created = await github.rest.issues.create({
        owner,
        repo,
        title,
        body: body.join('\n'),
        labels: [label]
      })
      core.info(`${job}: opened new issue #${created.data.number}`)
    }
  }
}
