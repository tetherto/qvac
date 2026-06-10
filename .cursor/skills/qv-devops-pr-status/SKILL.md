---
name: qv-devops-pr-status
description: Team-wide PR dashboard for the DevOps pod, scoped to PRs authored by pod-roster members. Shows open PRs touching DevOps-owned paths and authored by DevOps leads/members, grouped into needs-your-re-review / stale (>3d) / needs-review, with merge-conflict warnings and a separate Excluded section for non-roster authors. Use when checking DevOps pod PR status, asking about stale PRs, or invoking /qv-devops-pr-status.
disable-model-invocation: true
---

# DevOps Pod PR Status

Thin wrapper over the shared pr-skills library, pinned to the DevOps pod and scoped to PRs authored by DevOps roster members (`leads ∪ members` in [.github/teams/devops.json](.github/teams/devops.json)).

The dashboard spans the qvac monorepo (filtered by the pod's `ownedPaths`) **plus** every repo declared under `extraRepos` in [.github/teams/devops.json](.github/teams/devops.json). For extra repos the pod is treated as the sole owner — every open PR there is in-scope regardless of touched paths. The monorepo (`tetherto/qvac`) is the primary repo and stays path-filtered; it is intentionally NOT listed under `extraRepos`. Today's `extraRepos` are an explicit curated list:

- Ops: `tetherto/github-ops`, `tetherto/oss-actions`, `tetherto/qvac-actions`, `tetherto/qvac-devops`, `tetherto/qvac-testops`, `tetherto/release-ops`, `tetherto/data-github-ops`
- Dev: `tetherto/qvac-workbench`, `tetherto/qvac-internal`, `tetherto/qvac-test-suite`, `tetherto/qvac-registry-vcpkg`, `tetherto/qvac-ext-lib-whisper.cpp`, `tetherto/qvac-ext-stable-diffusion.cpp`, `tetherto/qvac-fabric-llm.cpp`, `tetherto/qvac-ext-ggml`, `tetherto/qvac-ext-bergamot-translator`, `tetherto/qvac-ext-marian-dev`
- Research: `tetherto/qvac-research-tool-call`, `tetherto/qvac-research-medpsy`, `tetherto/qvac-research-translations-nmt`, `tetherto/qvac-research-evaluate`, `tetherto/qvac-research-synthetic-data-creation`, `tetherto/qvac-research-model-training`, `tetherto/qvac-model-tools`, `tetherto/qvac-rnd-fabric-llm-bitnet`, `tetherto/qvac-rnd-fabric-llm-finetune`

`extraRepos` entries are plain `owner/name` strings used as-is. Glob entries (an `owner/name` whose name segment contains `*`, e.g. `tetherto/qvac-*`) are also supported and resolved dynamically per run via `gh repo list <owner> --no-archived` — add one to the list if you'd rather track every matching repo automatically instead of curating. Any repo the script cannot read is skipped with a one-line warning on stderr.

## When to use this skill

**Use when:**

- User asks about open DevOps pod PRs, review status, or what needs attention
- User asks specifically about stale PRs touching DevOps paths
- User wants to know which DevOps pod PRs to review next
- User invokes `/qv-devops-pr-status`

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User must have read access to `tetherto/qvac` AND every repo declared under `extraRepos` (any repo the script cannot read is skipped with a one-line warning on stderr)
- Team roster + `extraRepos` maintained at [.github/teams/devops.json](.github/teams/devops.json)

## Usage

```bash
DATE="$(date -u +%Y-%m-%d)"
node .cursor/skills/_lib/pr-skills/pr-status.mjs --pod devops --mode team --authors pod \
  2> /tmp/devops-pr-status-${DATE}.stderr \
  | tee "/tmp/devops-pr-status-${DATE}.txt"
```

`--authors pod` restricts the main dashboard to PRs authored by DevOps roster members. PRs that touch DevOps-owned paths (in the monorepo) or live in any extra repo but are authored outside the roster are surfaced in a separate "Excluded" section at the bottom of the same dashboard, so the pod still has visibility into cross-pod work hitting its surfaces without those PRs polluting the queue. See [.cursor/skills/_lib/pr-skills/README.md](.cursor/skills/_lib/pr-skills/README.md) for the flag's full behavior.

`extraRepos` is honored only by `--mode team`. `--mode review` and `--mode my` continue to operate against the configured primary repo only (the monorepo); cross-repo personal review/my-PR dashboards are not in scope of this skill.

The first line of the dashboard is a `Repos:` summary listing the primary repo plus every extra repo that contributed to the run, so the user can see the full scope at a glance. PRs from extra repos render as `owner/repo#<num>` (e.g. `tetherto/qvac-workbench#42`); PRs from the primary monorepo render as bare `#<num>` exactly as before. The same prefix shows in the Excluded section.

For the personal review queue scoped to DevOps PRs, use `--mode review` (without `--authors pod` — review queue intentionally includes cross-pod authors whose review the user owes). That mode stays on the primary repo.

## Workflow

1. Run the script with `--pod devops --mode team --authors pod`, **teeing stdout to `/tmp/devops-pr-status-<YYYY-MM-DD>.txt`** so the dashboard is available for paste afterwards. Redirect stderr to a sibling `.stderr` file (it contains progress / `SLACK_VALIDATION_REQUIRED` notices and any skipped-repo warnings, not dashboard content).
2. Present the dashboard to the user in the **chat presentation format** (see below) — not as a raw paste of the script output.
3. Surface the summary header counts (need your re-review / stale / merge conflicts / excluded) prominently.
4. **Print the paste-ready copy commands.** The dashboard at `/tmp/devops-pr-status-<DATE>.txt` is plain text with two-space indent — when pasted into a Slack thread, Slack auto-renders the indented lines as nested bullets and turns `#<num>` into PR auto-links. No re-formatting is needed.

   ```bash
   pbcopy < /tmp/devops-pr-status-${DATE}.txt   # macOS
   xclip -selection clipboard < /tmp/devops-pr-status-${DATE}.txt   # Linux
   wl-copy < /tmp/devops-pr-status-${DATE}.txt   # Wayland
   ```

5. After showing results, offer: "Want me to review any of these? Provide the PR URL and I'll run `/qv-devops-pr-review` (or `/qv-pr-review` for the generic flow)."

## Chat presentation format

The in-chat rendering uses Markdown with hyperlinked PR numbers. This is distinct from the paste-ready Slack form (auto-linked plain text) saved to the temp file. Both must be produced on every run.

Required layout (in this exact order):

1. **Title line** — `## DevOps Pod — PR Status (authors scoped to roster)`.
2. **Headline summary** — one bold line restating the script summary counts (`N PRs need attention · X fully approved · Y need your re-review · Z stale`). Append `· <K> repos scanned` when the script's `Repos:` line lists more than just the primary repo (i.e., `extraRepos` resolved to at least one repo), so the user can see the scope at a glance.
3. **Roster line** — one-line listing of the roster:
   ```
   Roster: `Proletter` (lead) + `darkynt`, `GSServita`, `sidj-thr`, `tamer-hassan-tether`, `yauhenipankratovich-web`.
   ```
   Refresh from [.github/teams/devops.json](.github/teams/devops.json) on every run; do not hardcode if the file has drifted.
4. **Headline analysis** — one short paragraph identifying the highest-leverage cluster in the queue (e.g., "Four `QVAC-18047` PRs all sit on team-lead approval only — fastest path to drain the queue."). Skip when the queue is empty.
5. **`### :red_circle: Stale (>3d) — N`** — one bullet per stale PR.
6. **`### :large_yellow_circle: Needs Review — N`** — one bullet per active PR.
7. **`### :repeat: Needs your re-review — N`** — only if the section is non-empty.
8. **`### Excluded (non-roster authors)`** — populated from the script's "EXCLUDED" section. One bullet per PR. Acts as a quick visibility list, not a review queue.
9. **`### Paste-ready`** — the `pbcopy` / `xclip` / `wl-copy` block.

Bullet format for the active sections (Stale / Needs Review / Re-review):

```
- [<ref>](<url>) — <title> · `<author-login>` · <age> · <approvals/notes> · **<blockers/labels>**
```

- `<ref>` is `#<num>` for PRs in the primary monorepo and `owner/repo#<num>` (e.g. `tetherto/qvac-workbench#42`) for PRs from any `extraRepos` entry. Mirror the script's `prRef` form 1:1 — the rendered link text must match what appears in the dashboard at `/tmp/devops-pr-status-<DATE>.txt`.
- `[<ref>](<url>)` — Markdown link, never bare `<ref>`.
- `<title>` is the PR title verbatim, no truncation.
- `<author-login>` is wrapped in backticks.
- `<age>` is the script's age string (e.g., `4d 13h`).
- `<approvals/notes>` lists `:white_check_mark: <login>` / `:x: <login>` / `:arrows_counterclockwise: <login>` for any non-pending reviews on the PR (from the script's `Reviews:` / `Other:` lines).
- `<blockers/notes>` is bolded — "needs team-lead approval", "needs team-member approval", "needs team-member + team-lead approval", or any `:warning: merge conflicts` flag. Include labels in plain backticks (e.g., `` `verified` ``) when present.

Bullet format for the Excluded section (compact — these are not the pod's review queue):

```
- [<ref>](<url>) `<author-login>`
```

## References

- Pod metadata: [.github/teams/devops.json](.github/teams/devops.json)
- Shared library README: [.cursor/skills/_lib/pr-skills/README.md](.cursor/skills/_lib/pr-skills/README.md)
- Generic PR review skill: [.cursor/skills/qv-pr-review/SKILL.md](.cursor/skills/qv-pr-review/SKILL.md)
- DevOps-flavored PR review skill: [.cursor/skills/qv-devops-pr-review/SKILL.md](.cursor/skills/qv-devops-pr-review/SKILL.md)
