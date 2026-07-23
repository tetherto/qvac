---
name: qv-sdk-pr-status
description: Team-wide PR dashboard for the SDK pod. Shows open PRs touching SDK pod paths or authored by SDK roster members, sorted oldest-first, grouped by author tier (SDK Core / Platform / External) into needs-your-re-review / stale / needs-review / fully-approved, with merge-conflict and CI-red warnings. Use when checking team SDK pod PR status or invoking /qv-sdk-pr-status.
disable-model-invocation: true
---

# SDK Pod PR Status

Thin wrapper over the shared pr-skills library, pinned to the SDK pod. PR data collection lives in `.cursor/skills/_lib/pr-skills/pr-activity.mjs`; this skill keeps the SDK-specific invocation.

## When to use this skill

**Use when:**

- User asks about open SDK pod PRs, review status, or what needs attention
- User wants to know which SDK pod PRs to review
- User invokes `/qv-sdk-pr-status`

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User must have access to the configured GitHub repository
- Team roster maintained at [.github/teams/sdk.json](.github/teams/sdk.json)

## Usage

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod sdk --mode team --authors union --tiers
```

- `--authors union` — PRs that touch SDK `ownedPaths` **or** are authored by an SDK roster member
- `--tiers` — split into SDK Core / Platform/Middleware / External Contribution (opt-in; other pods stay flat unless they pass the flag)

For the personal review queue, use `--mode review`. The script and its output format are documented in [.cursor/skills/_lib/pr-skills/README.md](.cursor/skills/_lib/pr-skills/README.md).

Machine-readable output for daily status workflows:

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod sdk --mode team --authors union --tiers --json
```

## Workflow

1. Run the script with `--pod sdk --mode team --authors union --tiers`.
2. Present the script's markdown output **as-is** to the user (do not reformat into tables or fenced code blocks). Stderr contains progress info — ignore it.
3. Surface the summary header counts (core / platform / external / re-review / stale / fully approved / merge conflicts) prominently.
4. After showing results, offer: "Want me to review any of these? Provide the PR URL and I'll run `/qv-pr-review`."
