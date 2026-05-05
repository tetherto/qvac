---
name: pr-mine
description: Show the current user's open PRs across every pod registered under .github/teams/, grouped by merge readiness, with copy-paste Slack ping messages routed to the owning pod's team. Use when the user asks about their own PRs, merge readiness, who to ping, or invokes /pr-mine.
disable-model-invocation: true
---

# My PRs

Cross-pod skill. Surfaces the current user's open PRs in `tetherto/qvac` and emits copy-paste Slack ping messages. The owning pod for each PR is auto-detected from the touched files against every `.github/teams/<pod>.json`'s `ownedPaths`, so per-PR ping logic uses the right team automatically — no `--pod` argument needed.

## When to use this skill

**Use when:**

- User asks about their own PRs, merge readiness, or who to ping
- User wants Slack messages to request reviews
- User invokes `/pr-mine`

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User must have access to `tetherto/qvac` repository
- At least one pod metadata file at `.github/teams/<pod>.json`
- Per-user Slack handle map at `~/.config/qvac-pr-skills/slack.json` (auto-bootstrapped on first run; see workflow step 2)

## Usage

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --mode my
```

`--pod` is intentionally omitted: `--mode my` discovers every pod and routes each PR to its owning pod automatically.

## Workflow

1. Run the script with `--mode my`.

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

1. **Ready to merge** — has both team member and team lead approval (per the PR's owning pod's team)
2. **Needs re-review** — a reviewer's approval was dismissed (new commits); shows who to re-request
3. **Awaiting review** — missing approvals; shows who to ping
4. **No pod matched** — touched files don't match any `.github/teams/<pod>.json` `ownedPaths`; ping logic is skipped (rare; usually means the user's PR is outside the pod system)

Each non-empty group of PRs needing pings includes ready-to-copy Slack messages with `@-mentions` and PR links sourced from `~/.config/qvac-pr-skills/slack.json` (falling back to `@<github-login>` when a handle is not yet mapped).

## Per-PR pod resolution

For each of the user's PRs, the script:

1. Lists the touched files via the GitHub API.
2. Walks the discovered pods (one per `.github/teams/*.json`) and picks the first one whose `ownedPaths` contains any touched path as a prefix. The walk order is `readdir` order of `.github/teams/`.
3. Uses that pod's `leads`, `members`, and Slack handles for the PR's "needs approval" / "ping" semantics.

If a PR touches files spanning multiple pods, the first match wins. This is fine for the typical case where a PR is owned by a single team. If two pods commonly share files, rename one of them in `.github/teams/` so the desired pod sorts first.

## Maintaining the Slack map

The script auto-fills new entries from `gh api users/<login>` when:

- the file does not yet exist (first run on this machine), OR
- a new login appears in any `.github/teams/<pod>.json` that is not yet in the map.

Newly seeded logins land in `pendingReview` and trigger the validation gate above on the next `--mode my` run. Edit `~/.config/qvac-pr-skills/slack.json` directly at any time to update handles; the file is per-user and never committed.
