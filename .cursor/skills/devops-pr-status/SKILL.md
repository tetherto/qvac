---
name: devops-pr-status
description: Team-wide PR dashboard for the DevOps pod. Shows open PRs touching DevOps-owned paths, grouped into needs-your-re-review / stale (>3d) / needs-review, with merge-conflict warnings. Use when checking DevOps pod PR status, asking about stale PRs, or invoking /devops-pr-status.
disable-model-invocation: true
---

# DevOps Pod PR Status

Thin wrapper over the shared pr-skills library, pinned to the DevOps pod.

## When to use this skill

**Use when:**

- User asks about open DevOps pod PRs, review status, or what needs attention
- User asks specifically about stale PRs touching DevOps paths
- User wants to know which DevOps pod PRs to review next
- User invokes `/devops-pr-status`

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User must have access to `tetherto/qvac` repository
- Team roster maintained at [.github/teams/devops.json](.github/teams/devops.json)

## Usage

```bash
DATE="$(date -u +%Y-%m-%d)"
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod devops --mode team \
  2> /tmp/devops-pr-status-${DATE}.stderr \
  | tee "/tmp/devops-pr-status-${DATE}.txt"
```

For the personal review queue scoped to DevOps PRs, use `--mode review`. The script and its output format are documented in [.cursor/skills/_lib/pr-skills/README.md](.cursor/skills/_lib/pr-skills/README.md).

## Workflow

1. Run the script with `--pod devops --mode team`, **teeing stdout to `/tmp/devops-pr-status-<YYYY-MM-DD>.txt`** so the dashboard is available for paste afterwards. Redirect stderr to a sibling `.stderr` file (it contains progress / `SLACK_VALIDATION_REQUIRED` notices, not dashboard content).
2. Present the grouped output to the user.
3. Surface the summary header counts (need your re-review / stale / merge conflicts) prominently.
4. **Print the paste-ready copy commands.** The dashboard is plain text with two-space indent — when pasted into a Slack thread, Slack auto-renders the indented lines as nested bullets and turns `#<num>` into PR auto-links (with the em-dash separator). No re-formatting is needed.

   ```bash
   pbcopy < /tmp/devops-pr-status-${DATE}.txt   # macOS
   xclip -selection clipboard < /tmp/devops-pr-status-${DATE}.txt   # Linux
   wl-copy < /tmp/devops-pr-status-${DATE}.txt   # Wayland
   ```

5. After showing results, offer: "Want me to review any of these? Provide the PR URL and I'll run `/devops-pr-review` (or `/pr-review` for the generic flow)."

## References

- Pod metadata: [.github/teams/devops.json](.github/teams/devops.json)
- Shared library README: [.cursor/skills/_lib/pr-skills/README.md](.cursor/skills/_lib/pr-skills/README.md)
- Generic PR review skill: [.cursor/skills/pr-review/SKILL.md](.cursor/skills/pr-review/SKILL.md)
- DevOps-flavored PR review skill: [.cursor/skills/devops-pr-review/SKILL.md](.cursor/skills/devops-pr-review/SKILL.md)
