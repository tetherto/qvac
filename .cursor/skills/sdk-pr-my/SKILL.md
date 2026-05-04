---
name: sdk-pr-my
description: Show current user's unmerged SDK pod PRs grouped by merge-readiness, with Slack-ready ping messages. Use when checking your own SDK pod PRs, finding what needs attention, or invoking /sdk-pr-my.
disable-model-invocation: true
---

# My SDK Pod PRs

Thin wrapper over the shared pr-skills library, pinned to the SDK pod. Surfaces the user's open PRs touching SDK pod paths and emits copy-paste Slack ping messages.

## When to use this skill

**Use when:**

- User asks about their own SDK pod PRs, merge readiness, or who to ping
- User wants Slack messages to request reviews
- User invokes `/sdk-pr-my`

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User must have access to `tetherto/qvac` repository
- Team roster maintained at [.github/teams/sdk.json](.github/teams/sdk.json)
- Per-user Slack handle map at `~/.config/qvac-pr-skills/slack.json` (auto-bootstrapped on first run; see workflow step 2)

## Usage

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod sdk --mode my
```

## Workflow

1. Run the script with `--pod sdk --mode my`.

2. **Slack-handle validation gate.** If the script's stderr contains `SLACK_VALIDATION_REQUIRED <N>`, run the validation flow before presenting any output to the user:

   a. Read `~/.config/qvac-pr-skills/slack.json`.
   b. For each login in `pendingReview`, present the proposed handle to the user via `AskQuestion` so they can confirm or correct. Use one question per pending login. Show the GitHub login and the proposed handle as the option label, e.g. `<github-login> -> <proposed-handle>`. Provide options: "keep proposed", "edit (then prompt for new handle)". Do NOT inline any names from the proposed map into commentary, examples, or follow-up text.
   c. For any logins the user chose to edit, ask one follow-up question per login for the corrected handle as free text.
   d. Apply corrections to `state.map`, set `state.pendingReview = []`, save the file (atomic write).
   e. Re-run the script. The marker should no longer fire.

3. Present the grouped output to the user (stderr contains progress info — ignore it).

4. For PRs in "needs re-review" or "awaiting review", present the "Slack messages (copy-paste ready)" sections in copy-friendly fenced code blocks so the user can paste directly into Slack.

5. Offer: "Want me to review any of these before requesting reviews? Provide the PR URL and I'll run `/pr-review`."

## Output groups

1. **Ready to merge** — has both team member and team lead approval
2. **Needs re-review** — a reviewer's approval was dismissed (new commits); shows who to re-request
3. **Awaiting review** — missing approvals; shows who to ping

Each group includes ready-to-copy Slack messages with `@-mentions` and PR links sourced from `~/.config/qvac-pr-skills/slack.json` (falling back to `@<github-login>` when a handle is not yet mapped).

## Maintaining the Slack map

The script auto-fills new entries from `gh api users/<login>` when:

- the file does not yet exist (first run on this machine), OR
- a new login appears in [.github/teams/sdk.json](.github/teams/sdk.json) that is not yet in the map.

Newly seeded logins land in `pendingReview` and trigger the validation gate above on the next `--mode my` run. Edit `~/.config/qvac-pr-skills/slack.json` directly at any time to update handles; the file is per-user and never committed.
