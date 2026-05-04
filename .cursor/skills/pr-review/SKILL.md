---
name: pr-review
description: Deep-dive review of any GitHub PR in tetherto/qvac. Validates gitflow, CI, title/body format, code quality, security, and applicable repo rules. Posts a PENDING review with inline comments. Use when reviewing a PR, given a PR link, or invoking /pr-review.
disable-model-invocation: true
---

# PR Review

Manual-trigger PR review for any GitHub PR in `tetherto/qvac`. Produces:

1. A short **overview in chat** (for the user — not posted anywhere).
2. A **PENDING** GitHub review containing only per-file:line inline comments (no review body).

The user submits the pending review manually from the GitHub UI.

## When to use this skill

**Use when:**

- User asks to review a PR or provides a PR URL
- User invokes `/pr-review`
- Triggered as follow-up from `/sdk-pr-status`, `/sdk-pr-my`, or another pod's status/my skill

The skill applies to any PR; cursor rules and PR-template format applicable to the touched paths are discovered dynamically (see step 4 / step 5).

## Inputs

- **Required**: PR URL (e.g. `https://github.com/tetherto/qvac/pull/1234`)
- **Optional**: user-provided notes/comments to seed the review (focus areas, specific concerns)

If PR URL is missing, ask for it. Nothing else to ask unless the user's seed notes are ambiguous.

## Review philosophy

Carefully check the changes, focusing on:

1. **High-risk issues** — bugs that corrupt data, break security/auth, violate gitflow, or fail CI.
2. **Potential bugs** — logic errors, wrong types, missing error handling, race conditions, off-by-one, unhandled edge cases.
3. **Unintentional or non-obvious caveats** — subtle behavior changes that aren't called out (default flips, silent fallbacks, ordering changes, hidden coupling, regex gaps, schema gaps).
4. **Breaks to existing functionality** — changes that look additive but alter behavior of existing callers (signature changes, default changes, removed branches, semantically different return values).

Style nits, doc polish, and unverified hunches are NOT the focus. Don't pad the review with them.

### Severity tiers

Use these tiers when assembling findings. Tiers drive what surfaces in the chat overview and what is **proposed** for inline comments. The user always has final say over what gets posted.

- **High** — almost-certain bug, security issue, gitflow blocker, CI failure, or break of existing behavior. Surfaces in chat overview. **Proposed for inline by default.**
- **Medium** — likely bug, non-obvious caveat, missing test coverage on a risky path, or a subtle behavior change. Surfaces in chat overview. **Proposed for inline by default.**
- **Low** — style, minor docstring drift, optional ergonomic improvement. Surfaces in chat overview when material (informative for the reviewer). **Not proposed for inline by default** — only added if the user explicitly opts them in.

Selection rule: never silently include a Low finding in the inline payload. The user picks (see step 7b).

## Safety rules — DO NOT TOUCH THE USER'S LOCAL REPO

This skill is **read-only with respect to the local working tree**. The user may have uncommitted changes, be on a feature branch, or have pending work — never disturb it.

**Forbidden commands** (no matter the circumstance):

- `git switch`, `git checkout` (any ref/file)
- `git reset` (any mode), `git restore`
- `git stash` (push, pop, drop, anything)
- `git pull`, `git merge`, `git rebase`, `git cherry-pick`
- `git fetch` (not needed — all data comes from the GitHub API)
- `git clean`
- `gh pr checkout`
- Any write to working tree files outside `/tmp/`

If you need PR file contents at a specific ref, use `gh api repos/{owner}/{repo}/contents/{path}?ref={sha}` and write to `/tmp/`. Read cursor rules and repo conventions from the user's current workspace as-is — do not switch branches to "get the latest" version.

## Efficiency rules

Every shell call costs a user approval. Keep the total small (~5-8 calls).

- **Use dedicated tools, not shell.** Read instead of `cat`/`head`/`tail`, Grep instead of `grep`/`rg`, Glob instead of `find`, Write instead of `echo >` / heredoc.
- **Do not `gh pr checkout`.** The diff is enough; if more file context is needed, fetch via `gh api .../contents/...?ref=<sha>` into `/tmp/`.
- **Fetch each piece of data ONCE.** Save to `/tmp/pr-<num>.json` and `/tmp/pr-<num>.patch`, reuse via Read/Grep.
- **Skip `gh pr checks`** — `statusCheckRollup` in `gh pr view --json` already has every check.
- **Fetch CI logs only for failing jobs**, not every job. One `gh run view --log-failed --job <id>` per failing job.
- **Never run encoding forensics** (`file`, `od`, `wc -c`, `cat -A`) unless a CI log explicitly names an encoding issue.

## Workflow

Copy this checklist and track progress:

```
- [ ] 1. Parse PR URL
- [ ] 2. Fetch PR data (2 shell calls)
- [ ] 3. Validate gitflow
- [ ] 4. Read applicable cursor rules for the touched paths
- [ ] 5. Validate PR title + body against the discovered format rules
- [ ] 6. Review: CI + general + security + rules — classify findings by severity
- [ ] 7a. Print risk overview in chat (high + medium + material lows)
- [ ] 7b. Ask user which findings to include as inline comments (high+medium pre-selected, lows opt-in)
- [ ] 8. Assemble inline comments + write payload (only the user-confirmed set)
- [ ] 9. Pre-flight check (count, files, line numbers)
- [ ] 10. Show gh api command, wait for user confirmation
- [ ] 11. POST the PENDING review
- [ ] 12. Output link to pending review
```

### 1. Parse PR URL

Extract owner, repo, pr_number from the URL. Verify repo matches `tetherto/qvac`.

### 2. Fetch PR data (exactly 2 shell calls)

```bash
gh pr view <num> --repo tetherto/qvac \
  --json number,title,state,mergeable,baseRefName,headRefName,headRefOid,isCrossRepository,headRepositoryOwner,files,author,body,statusCheckRollup \
  > /tmp/pr-<num>.json

gh pr diff <num> --repo tetherto/qvac --patch > /tmp/pr-<num>.patch
```

Everything else comes from these files via Read/Grep. No additional shell calls for PR data.

### 3. Gitflow validation

Read `baseRefName`, `headRefName`, `isCrossRepository`, `headRepositoryOwner` from `/tmp/pr-<num>.json`. Full gitflow rules are in `docs/gitflow.md`.

**Allowed directions (fork to upstream):**

| Head (fork branch) | Base (upstream) | OK? |
|---|---|---|
| anything | `main` | yes |
| anything | `release-<pkg>-<x.y.z>` | yes (must bump version + changelog) |
| anything | `feature-<pkg>-*` / `tmp-<pkg>-*` | yes |

**Blocker patterns:**

- `release-*` to `main` — WRONG
- `main` to `release-*` — WRONG
- `release-*` to `release-*` — WRONG
- `feature-*` / `tmp-*` to `main` — WRONG
- `main` to `feature-*` / `tmp-*` — WRONG
- Head branch in upstream org (not a fork) — flag as suspicious

**Release-PR extra checks (base is `release-<pkg>-<x.y.z>`):**

- `packages/<pkg>/package.json` version must increase vs base
- `packages/<pkg>/CHANGELOG.md` must be updated
- Verify patch fixes already landed on main (cherry-picked commits)

### 4. Read applicable cursor rules for the touched paths

Use Glob/Read tools (no shell). The repo organizes cursor rules per area under `.cursor/rules/<area>/`. To pick which apply to this PR:

1. Look at the touched paths from `/tmp/pr-<num>.json` (`files[].path`).
2. Glob `.cursor/rules/**/*.mdc` and look at each file's frontmatter `globs` field. Load any rule whose globs match at least one touched path. (Many rules also have `alwaysApply: true` and apply regardless.)
3. If `.github/teams/<pod>.json` exists for a pod whose `ownedPaths` match the touched files, that pod's conventions are the relevant ones; load any rule under `.cursor/rules/<pod>/` (e.g. `main.mdc`, `commit-and-pr-format.mdc`, `error-handling.mdc`, `<pod>-pod-packages.mdc`).

If no rules match, skip this step. Do not hardcode rule paths.

### 5. Validate PR title + body against discovered format rules

If a `commit-and-pr-format.mdc`-style rule was loaded in step 4, validate the PR title and body against it. Common shape (used by the SDK pod and likely others):

**Title** (format: `TICKET prefix[tag]: subject` or `prefix[notask]: subject`):

- Prefix: `feat` `fix` `doc` `test` `chore` `infra`
- Tags (not combinable): `[api]` `[bc]` `[mod]` `[notask]` `[skiplog]`
- `[api]` required when diff adds new exports/public API surface
- `[bc]` required when diff removes/changes existing public API signatures
- `[mod]` required when model constants change

**Body** — use the matching `.github/PULL_REQUEST_TEMPLATE/<template>.md` if one is referenced by the loaded rule:

- "What problem" describes user impact, not implementation
- "How it solves" is high-level, not line-by-line
- `[bc]` requires BEFORE/AFTER code blocks
- `[api]` requires usage example
- `[mod]` requires Added/Removed models list
- Unused template sections deleted

If no format rule applies, skip this step. Title/body violations go in the **chat overview only**, not as inline PR comments.

### 6. Review dimensions

Apply the review philosophy. Classify every finding as **High**, **Medium**, or **Low**. Skip any dimension with no findings.

- **Gitflow**: wrong merge direction, missing version bump/changelog on release PRs (almost always High)
- **CI**: non-green checks (ignore `*Approval*`/`approval-worker`). Name the failing job + actual error. For failing jobs only: `gh run view --repo tetherto/qvac --log-failed --job <job_id> > /tmp/pr-<num>-<job_id>.log` (High)
- **Bugs / correctness**: logic errors, wrong types, off-by-one, missing error handling, race conditions, unhandled edge cases (High or Medium)
- **Breaks to existing functionality**: changes that look additive but alter callers' behavior — signature changes, default flips, removed branches, semantically different return values (High)
- **Non-obvious caveats**: silent fallbacks, schema/regex gaps, validation that doesn't actually validate the property the test name implies, hidden ordering/coupling, addon contract drift (Medium)
- **Security**: injection, secrets in code/logs, auth/authz, unsafe deserialization, SSRF, prototype pollution, crypto misuse, dependency risks (High unless clearly informational)
- **Test coverage on risky paths**: a new feature or refactor that ships without tests proving the risky bit (Medium)
- **Repo rules**: violations of the cursor rules loaded in step 4 (Low unless they hide a bug)
- **User notes**: address seed notes explicitly if provided. Prioritize per the user's framing.

When verifying a suspected bug, attempt to construct a concrete reproduction (input → code path → observed behavior). If you cannot, classify it Medium at most and say so.

### 7a. Print risk overview in chat (BEFORE assembling comments)

Print the overview below directly in chat. This is for the user — nothing is posted yet. After printing, pause for the selection step (7b). If the user pushes back on a finding, drop it before continuing.

**Important**: the user's local checkout may be on a different branch / different commit than the PR head. They cannot trust line numbers from their working tree. Every High/Medium finding MUST therefore include:

1. A short **code excerpt fetched from the PR head SHA** (already in `/tmp/pr-<num>-<file>.ts` from step 6 verification, or via `gh api repos/{owner}/{repo}/contents/{path}?ref={headRefOid}`). 3-8 lines of context max — just enough to make the bug visible without the user opening the PR.
2. A **deep link to the PR file diff** so the user can click straight to the right place on GitHub. GitHub PR file anchors use **SHA256** of the file path (GitHub switched from MD5/SHA1 in 2022):

   `https://github.com/tetherto/qvac/pull/<num>/files#diff-<sha256(path)>R<line>`

   Where `<sha256(path)>` is `sha256(<path>)` (lowercase hex, no trailing newline). The `R<line>` suffix anchors the right (post-change) side at that line; use `L<line>` for the left side.

   Compute it in shell:

   ```bash
   printf '%s' 'packages/sdk/foo.ts' | shasum -a 256 | awk '{print $1}'
   ```

   **Fallback** when SHA256 isn't convenient: link to the blob at the head SHA — `https://github.com/tetherto/qvac/blob/<headRefOid>/<path>#L<line>` — also clickable and lands on the right line, but doesn't show the diff context. Prefer the diff anchor when you have it.

   Do NOT use SHA1 of the path — that produces a hash GitHub no longer recognises and the anchor will silently fail to scroll.

Format:

````markdown
## PR #<num> — review overview

<1-line summary of what this PR does>

### Gitflow / Title / CI
<one-line status, omit subsections that are clean>

### High-risk
<numbered list — empty list is fine, write "none" explicitly>

1. **<short title>** — [`<path>:<line>`](<deep link>)

   <one-sentence explanation, with repro hint if relevant>

   ```ts
   <3-8 line excerpt from the PR head>
   ```

### Medium-risk
<numbered list — empty list is fine, write "none" explicitly>

1. **<short title>** — [`<path>:<line>`](<deep link>)

   <one-sentence explanation>

   ```ts
   <3-8 line excerpt from the PR head>
   ```

### Low-risk (informational)
<numbered list — omit the section entirely if there are no material lows>

1. **<short title>** — [`<path>:<line>`](<deep link>)

   <one-sentence note>

### Verified (no action)
<optional: short bullets for things you specifically checked and cleared, only if the reviewer might otherwise wonder>

---

PR diff: <https://github.com/tetherto/qvac/pull/<num>/files>
````

Rules for what goes in each section:

- **High / Medium**: every finding gets the link + 3-8 line excerpt. Keep the explanation to one sentence; excerpt does the rest. Detailed reasoning + reproduction goes in the inline comment in step 8.
- **Low (informational)**: include only when the finding is genuinely useful to the reviewer (e.g. a doc gap, an ergonomic improvement, an addon-contract drift worth knowing). Skip the excerpt for lows — a one-sentence note + link is enough. Trivial nits (whitespace, opinion-based naming) should be dropped, not demoted to Low.
- **Verified**: only when the reviewer might reasonably wonder whether you checked something.

The excerpts MUST come from files at the PR head SHA, never from the user's working tree. Fetch any file you need with `gh api repos/{owner}/{repo}/contents/{path}?ref=<headRefOid>` (decode `.content` from base64) and Read it from `/tmp/`. The excerpt's line numbers must match the line you're calling out.

### 7b. Ask the user which findings to include as inline comments

Immediately after the overview, present a confirmation prompt. The defaults follow the severity tier rules (high+medium pre-selected, lows opt-in). The user can override any selection.

Use a structured multi-select question (one per finding) so the user clicks instead of typing. Format the prompt as:

```
For each finding, confirm whether it should be posted as an inline comment.
Defaults: High + Medium = include; Low = skip.
```

Each finding becomes one option in a single multi-select question (id `inline_picks`, `allow_multiple: true`). Pre-select High + Medium by listing them as the recommended choices in the prompt text (the tool itself doesn't surface defaults, so spell them out: e.g. "Recommended: 1, 2, 3"). Lows are listed as additional options.

If the user is text-driven instead of clicking, accept replies like:

- "all" / "default" / "yes" → include the recommended set (high+medium only)
- "1, 3" → include findings 1 and 3 only
- "all + L1" → recommended set plus Low #1
- "drop 2" → recommended set minus #2
- "none" → skip the inline review entirely (still allowed; just stop here)

Echo back the final selected list before moving to step 8 so the user can object once more. Do NOT proceed to step 8 until you have an explicit confirmation. If the user picks "none", skip steps 8-12 and end the session.

## Comment style

- Casual but professional. No fluff.
- Bullet points over prose. Write like a human reviewer.
- **No severity prefixes** (`blocker:`, `nit:`, etc.) inside the comment body — severity is conveyed by which findings make it into the chat overview.
- Say WHAT + WHY + brief FIX. Use GitHub suggestion blocks only for mechanical fixes.
- For High/Medium findings, include a concrete reproduction path when one exists.
- No praise padding. No "LGTM overall but...". Land findings directly.

## Posting the review

### 8. Write comment payload

Build the payload from the **user-confirmed selection in step 7b only**. Never include a finding the user did not opt into (especially Lows). If the confirmed set is empty, stop here — don't post an empty review.

Use the Write tool to create `/tmp/pr-<num>-review.json`:

```json
{
  "commit_id": "<headRefOid>",
  "comments": [
    {
      "path": "packages/<pkg>/src/foo.ts",
      "line": 42,
      "body": "comment text"
    }
  ]
}
```

Omit the `event` field. The GitHub REST API only accepts `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`; omitting it leaves the review in PENDING state, which is what this skill targets.

Line numbers must reference the **post-PR file line numbers** (the `+` side line numbers in the patch, mapped to the file at the PR head SHA). When in doubt, fetch the file at the head SHA via `gh api repos/{owner}/{repo}/contents/{path}?ref={sha}` and verify line numbers there before composing the payload.

### 9. Pre-flight check

Show the user:

1. Count of inline comments and which files they touch. Cross-reference against the user-confirmed selection from step 7b — counts MUST match exactly. If they don't, something was added or dropped silently; stop and reconcile before proceeding.
2. **A rendered Markdown preview of every inline comment**, one per file:line anchor. Reproduce the comment body verbatim as Markdown — do NOT show the raw JSON payload, do NOT escape newlines. The user reads the preview to decide whether to approve posting; raw JSON is unreadable. Format:

   ```markdown
   ### Preview — comment <n> of <total>

   **File**: `<path>:<line>`

   ---

   <verbatim comment body, rendered as Markdown>

   ---
   ```

   If the comment body contains fenced code blocks, render them as fenced code blocks in the preview (not as escaped strings).

### 10. Wait for confirmation

Show the exact `gh api` command but do NOT run it until the user says to proceed:

```bash
gh api repos/tetherto/qvac/pulls/<num>/reviews \
  --method POST \
  --input /tmp/pr-<num>-review.json
```

### 11. Post on confirmation

Run the command. If it fails, show the error and the JSON payload for debugging.

### 12. Output link

```
https://github.com/tetherto/qvac/pull/<num>#pullrequestreview-<review_id>
```

## References

- Per-pod team metadata + ownedPaths: `.github/teams/<pod>.json`
- Per-pod cursor rules: `.cursor/rules/<pod>/`
- PR templates: `.github/PULL_REQUEST_TEMPLATE/`
- Gitflow: `docs/gitflow.md`
