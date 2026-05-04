# pr-skills shared library

Shared script + helpers for the per-pod PR status / queue / my-PR skills.

This directory does not contain a `SKILL.md`; it is not a Cursor skill itself. The actual user-facing skills are thin wrappers under `.cursor/skills/<pod>-pr-status/` and `.cursor/skills/<pod>-pr-my/` that invoke the shared script with `--pod <name>`.

## Files

- [`pr-status.mjs`](pr-status.mjs) — main entry. Modes: `team`, `review`, `my`. Reads team metadata from `.github/teams/<pod>.json`. Reads Slack handles from `~/.config/qvac-pr-skills/slack.json`.
- [`team.mjs`](team.mjs) — team-metadata loader. Resolves the repo root by walking up to the first `.git/` and reads `.github/teams/<pod>.json`. Validates `leads`, `members`, `ownedPaths` are arrays of strings.
- [`slack.mjs`](slack.mjs) — Slack-handle map loader. File lives at `~/.config/qvac-pr-skills/slack.json`, schema `{ map, pendingReview }`. Bootstraps missing entries from `gh api users/<login>` and parks newly seeded logins on `pendingReview` so the skill workflow can confirm them with the user.

## Modes

| Mode | What it shows | Used by |
|---|---|---|
| `team` | All open PRs touching the pod's `ownedPaths` that still need reviews. Three sections: needs-your-re-review, stale (>3d), needs-review. PRs with `mergeable: CONFLICTING` are flagged with `⚠️ MERGE CONFLICTS!`. | `<pod>-pr-status` |
| `review` | The current user's personal review queue: PRs needing their first review, plus PRs where their review was dismissed. | (currently unused; available for a future skill) |
| `my` | The current user's own open PRs grouped by merge readiness. Emits copy-paste Slack ping messages for missing reviewers. | `<pod>-pr-my` |

## CLI

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod <name> --mode <team|review|my>
```

`--pod` is required. The script exits 1 if `.github/teams/<pod>.json` is missing or malformed.

## Onboarding a new pod

1. Drop a team metadata file at `.github/teams/<pod>.json`:

   ```json
   {
     "name": "<Display Name>",
     "leads": ["<github-login>", "..."],
     "members": ["<github-login>", "..."],
     "ownedPaths": ["packages/<pkg-a>/", "packages/<pkg-b>/"]
   }
   ```

   `ownedPaths` are prefix-matched against changed-file paths to decide whether a PR is "owned" by this pod. Use trailing slashes.

2. Create two thin wrapper skills by copying `.cursor/skills/sdk-pr-status/` to `.cursor/skills/<pod>-pr-status/` and `.cursor/skills/sdk-pr-my/` to `.cursor/skills/<pod>-pr-my/`.

3. Inside each copy, update the SKILL.md frontmatter (`name:`, `description:`) and the script invocation in the `## Usage` block to swap `--pod sdk` for `--pod <pod>`. No other changes required.

4. The first time anyone on the new pod runs `<pod>-pr-my`, the shared script auto-fills `~/.config/qvac-pr-skills/slack.json` with `gh api users/<login>` names for the newly added logins and emits `SLACK_VALIDATION_REQUIRED <N>` on stderr, prompting the skill workflow to drive a confirm-or-correct flow with the user.

`/pr-review` is not pod-specific and does not need duplication; it lives at `.cursor/skills/pr-review/` and applies to any PR in `tetherto/qvac`.

## Slack-handle map (per-user, never committed)

- File: `~/.config/qvac-pr-skills/slack.json`
- Schema:
  ```json
  {
    "map": { "<github-login>": "<slack-handle>" },
    "pendingReview": ["<github-login>"]
  }
  ```
- The script appends to `pendingReview` whenever it auto-fills a new entry. The `<pod>-pr-my` SKILL workflow consumes the pending list, presents each entry to the user via `AskQuestion`, applies corrections, and clears `pendingReview` once validation is done.
- Edit the file directly at any time — the script never overwrites entries already in `map`, only adds new ones.
