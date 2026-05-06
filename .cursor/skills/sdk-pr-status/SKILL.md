---
name: sdk-pr-status
description: Team-wide PR dashboard for the SDK pod. Shows open PRs touching SDK pod paths, sorted oldest-first, grouped into needs-your-re-review / stale / needs-review, with merge-conflict warnings. Use when checking team SDK pod PR status or invoking /sdk-pr-status.
disable-model-invocation: true
---

# SDK Pod PR Status

Thin wrapper over the shared pr-skills library, pinned to the SDK pod.

## When to use this skill

**Use when:**

- User asks about open SDK pod PRs, review status, or what needs attention
- User wants to know which SDK pod PRs to review
- User invokes `/sdk-pr-status`

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User must have access to `tetherto/qvac` repository
- Team roster maintained at [.github/teams/sdk.json](.github/teams/sdk.json)

## Usage

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod sdk --mode team
```

For the personal review queue, use `--mode review`. The script and its output format are documented in [.cursor/skills/_lib/pr-skills/README.md](.cursor/skills/_lib/pr-skills/README.md).

## Workflow

1. Run the script with `--pod sdk --mode team`.
2. Present the grouped output to the user (stderr contains progress info — ignore it).
3. Surface the summary header counts (need your re-review / stale / merge conflicts) prominently.
4. After showing results, offer: "Want me to review any of these? Provide the PR URL and I'll run `/pr-review`."
