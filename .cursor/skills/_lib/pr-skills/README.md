# pr-skills shared library

Shared script + helpers for the PR status / review-queue / my-PR / PR-review skills.

This directory does not contain a `SKILL.md`; it is not a Cursor skill itself. The user-facing skills live under `.cursor/skills/`:

- `pr-review/` — generic single-PR review. Pod-agnostic.
- `pr-mine/` — cross-pod "my open PRs" dashboard. Discovers every pod under `.github/teams/` and routes per-PR ping logic to the owning pod.
- `<pod>-pr-status/` — per-pod team dashboard, thin wrapper invoking the shared script with `--pod <name> --mode team`.

## Files

- [`pr-status.mjs`](pr-status.mjs) — main entry. Modes: `team`, `review`, `my`. `team` and `review` are pod-scoped (`--pod` required). `my` is cross-pod by default (`--pod` optional; if omitted, every pod under `.github/teams/` is loaded).
- [`team.mjs`](team.mjs) — team-metadata loader. `loadTeam(pod)` reads a single pod; `discoverPods()` enumerates every `.github/teams/<pod>.json`; `findPodForFiles(files, pods)` returns the pod that owns a PR's touched files (first match wins).
- [`slack.mjs`](slack.mjs) — Slack-handle map loader. File lives at `~/.config/qvac-pr-skills/slack.json`, schema `{ map, pendingReview }`. Bootstraps missing entries from `gh api users/<login>` and parks newly seeded logins on `pendingReview` so the skill workflow can confirm them with the user.
- [`worktree.mjs`](worktree.mjs) — worktree manager for `/pr-review`. `resolvePR` (gh-resolved baseRefName, fail-fast — does NOT default to main), `fetchPRRefs` (single fetch for both PR head and base ref), `ensureWorktreeSynced` (sync mode, in-place `reset --hard` on SHA drift), `lockPR` (per-PR flock), `computePatch` (3-dot diff to `/tmp/pr-<num>.patch`), `cleanupCache` (LRU keep 5).
- [`worktree-prepare.mjs`](worktree-prepare.mjs) — CLI entry for `/pr-review`'s worktree mode. Success: prints `WORKTREE_PATH`, `HEAD_SHA`, `PATCH_PATH`, `BASE_REF` on stdout. Any failure: prints `WORKTREE_FALLBACK=<reason>` on stderr and exits 0 so the agent transparently falls back to API-only mode.

## Modes

| Mode | Pod scope | What it shows | Used by |
|---|---|---|---|
| `team` | required (`--pod`) | All open PRs touching the pod's `ownedPaths` that still need reviews. Three sections: needs-your-re-review, stale (>3d), needs-review. PRs with `mergeable: CONFLICTING` are flagged with `⚠️ MERGE CONFLICTS!`. | `<pod>-pr-status` |
| `review` | required (`--pod`) | The current user's personal review queue: PRs needing their first review, plus PRs where their review was dismissed. | (currently unused; available for a future skill) |
| `my` | optional (`--pod`); cross-pod by default | The current user's own open PRs grouped by merge readiness. Per-PR pod resolution drives ping logic. Emits copy-paste Slack ping messages for missing reviewers. | `pr-mine` |

## CLI

```bash
# pod-scoped
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod <name> --mode <team|review>

# cross-pod (auto-detects per-PR pod from .github/teams/*.json)
node .cursor/skills/_lib/pr-skills/pr-status.mjs --mode my

# pod-scoped my (unusual — only useful if you want to filter to a single pod)
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod <name> --mode my
```

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

2. Create the per-pod dashboard skill by copying `.cursor/skills/sdk-pr-status/` to `.cursor/skills/<pod>-pr-status/`. Inside the copy, update the SKILL.md frontmatter (`name:`, `description:`) and the script invocation in the `## Usage` block to swap `--pod sdk` for `--pod <pod>`. No other changes required.

3. `pr-mine` and `pr-review` are NOT pod-specific and do not need duplication. They live at `.cursor/skills/pr-mine/` and `.cursor/skills/pr-review/` and discover the new pod automatically.

4. The first time anyone on the new pod runs `/pr-mine`, the shared script auto-fills `~/.config/qvac-pr-skills/slack.json` with `gh api users/<login>` names for the newly added logins and emits `SLACK_VALIDATION_REQUIRED <N>` on stderr, prompting the skill workflow to drive a confirm-or-correct flow with the user.

## Slack-handle map (per-user, never committed)

- File: `~/.config/qvac-pr-skills/slack.json`
- Schema:
  ```json
  {
    "map": { "<github-login>": "<slack-handle>" },
    "pendingReview": ["<github-login>"]
  }
  ```
- The script appends to `pendingReview` whenever it auto-fills a new entry. The `pr-mine` SKILL workflow consumes the pending list, presents each entry to the user via `AskQuestion`, applies corrections, and clears `pendingReview` once validation is done.
- Edit the file directly at any time — the script never overwrites entries already in `map`, only adds new ones.

## Worktree cache (per-user, never committed)

- Directory: `~/.cache/qvac-pr-review/`
- One subdirectory per PR num: `pr-<num>/` (sync mode — single path per PR, kept in sync via `fetch + reset --hard` when SHA advances).
- One lock file per PR num: `pr-<num>.lock`. Held by `worktree-prepare.mjs` for the duration of fetch + sync; released before printing the path. Same-PR concurrent invocations serialize on this lock.
- LRU eviction: only the 5 most recently touched worktrees are retained. Older entries are removed via `git worktree remove --force` + `rm -rf`.
- Used only by `/pr-review` (default-on, opt out with `--no-worktree`).
