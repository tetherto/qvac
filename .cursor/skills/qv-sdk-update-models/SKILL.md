---
name: qv-sdk-update-models
description: >-
  Regenerates SDK model constants from the live QVAC registry and opens a [mod]
  PR. Use when registry models landed and packages/sdk models.ts needs syncing,
  or when invoking /qv-sdk-update-models. Optional cascade refreshes
  ai-sdk-provider and sdk-python generated catalogs.
disable-model-invocation: true
---

# SDK Update Models

Regenerate `@qvac/sdk` static model constants from the live P2P registry, then
open a `[mod]` PR. Registry sync does **not** auto-update SDK constants — this
skill is the deliberate regen + PR path.

## When to use this skill

**Use when:**

- New/updated/removed models landed in the production registry and SDK constants
  are stale.
- Someone asks to "update models", "sync models.ts", or "run update-models".
- User invokes `/qv-sdk-update-models`.

**Do NOT use when:**

- Changing naming rules / companion detection / codegen logic (those are code
  changes; regen may be a follow-up, not the whole PR).
- Only needing a dry-run drift check — run `bun run check-models` directly.
- Releasing / changelog work — use `qv-sdk-changelog` after the `[mod]` PR merges.

## Flags

| Flag | Behavior |
|------|----------|
| *(none)* | SDK only: `packages/sdk` regen + `[mod]` PR |
| `--cascade` | Also regen `@qvac/ai-sdk-provider` and `packages/sdk-python` |
| `--with-provider` | Cascade provider only |
| `--with-python` | Cascade python only (usually after SDK `contract:export`) |
| `--check-only` | Run `check-models` and report; do not write or open a PR |
| `--no-pr` | Regen + commit plan only; skip PR creation |
| `--notask` | Allow `feat[mod|notask]: …` when no ticket is available |

Combine as needed: `/qv-sdk-update-models --cascade`, `/qv-sdk-update-models --check-only`.

## Prerequisites

- Working directory is the `qvac` monorepo root (or resolve paths from it).
- Network access to the live registry (Hyperswarm / Hyperdrive).
- `packages/sdk` dependencies installed (`bun install` in that package if needed).
- Optional: `QVAC_REGISTRY_CORE_KEY` to target a non-default registry core.
- For `--with-python` / `--cascade`: `packages/sdk-python/.venv` with gen extras
  (`python3 -m venv .venv && .venv/bin/pip install -e ".[gen,dev,bare-rpc]"`).
- `gh` CLI for PR creation (same expectations as `qv-sdk-pr-create`).

**Secrets:** this skill only needs registry network access. It does not read
`GH_TOKEN` / `HF_TOKEN` / `NPM_TOKEN` unless a chained skill does.

## Safety rules

- **Plan-then-apply.** Print the planned commands and expected file set; wait for
  explicit user confirmation before regen, commit, push, or `gh pr create`.
- **No silent git mutations.** Do not `git switch` / `checkout` / `stash` /
  `pull` / `merge` / `rebase` without explicit user instruction.
- **Fail-stop** on unexpected dirty files, missing tools, or registry errors.
- **Do not edit** `naming.ts`, companion logic, schemas, or hand-written API
  code. If those need changes, stop and tell the user this skill is the wrong
  tool.
- Prefer **draft=false / Ready for review** org-branch PRs when the user wants
  baseline CI (same preference as `qv-sdk-pr-create`).

## Expected file sets

### SDK (always)

After a successful `bun run update-models` in `packages/sdk/`:

- `packages/sdk/models/registry/models.ts`
- `packages/sdk/models/history/<short-sha>.txt` (only when add/update/remove)
- `packages/sdk/contract/models.json` (via chained `contract:export`)
- Possibly other `packages/sdk/contract/*` if export rewrites them — include if
  `git status` shows them; do not invent diffs.

### Provider (`--with-provider` / `--cascade`)

- `packages/ai-sdk-provider/src/models/constants.ts`
- `packages/ai-sdk-provider/models/history/<short-sha>.txt` (when delta exists)

### Python (`--with-python` / `--cascade`)

- `packages/sdk-python/src/tetherto/qvac_sdk/_generated/models_registry.py`
- Other `_generated/**` files if `generate.py` rewrites them — include if dirty.

If `git status` shows files outside the active file set, **STOP** and ask.

## Workflow

### Step 0 — Parse flags and resolve ticket

1. Parse flags from the user message.
2. Ticket:
   - Prefer `QVAC-\d+` / `SDK-\d+` from branch name or user message.
   - If missing and `--notask` was passed → use `[notask]`.
   - If missing and no `--notask` → **ASK** for a ticket (or confirm `--notask`).

### Step 1 — Preflight (read-only)

From monorepo root:

1. `git status -sb` and `git status --porcelain`.
2. Allowed dirty paths before regen: none, **or** only files already in the
   expected file set from a prior interrupted run of this skill.
3. Confirm remotes (`git remote -v`) for later PR push (org remote preferred).
4. Print plan:

```text
Plan:
  1. bun run check-models   (packages/sdk)
  2. bun run update-models  (packages/sdk)   [needs confirm]
  3. [optional] provider / python cascade
  4. commit feat[mod] …
  5. open PR via qv-sdk-pr-create
Ticket: …
Cascade: none | provider | python | both
```

5. If `--check-only`: run Step 2 only, report, **stop**.
6. Otherwise ask: "Proceed with regen?" — wait for yes.

### Step 2 — Drift check

```bash
cd packages/sdk
bun run check-models
```

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Up to date | Report "already synced" and **stop** (unless user still wants cascade-only — ask) |
| 1 | Drift / timeout / error | Read stdout. If it lists new/updated/removed models, continue. If timeout/error, fail-stop |
| other | Unexpected | Fail-stop |

Capture Added / Updated / Removed names from the check output when present —
useful if history later looks bogus.

### Step 3 — Regenerate SDK

After user confirmation:

```bash
cd packages/sdk
bun run update-models
```

Then:

```bash
cd packages/sdk
bun run contract:check
```

`contract:check` must pass (update-models already ran export; this verifies).

Inspect `git status`. Confirm only the SDK expected file set is dirty.

### Step 4 — Optional cascade

#### Provider

If `--cascade` or `--with-provider`:

```bash
cd packages/ai-sdk-provider
bun run update-models
```

Note: provider filters engines without OpenAI-shaped endpoints (e.g. VAD). A
smaller delta than SDK is expected.

#### Python

If `--cascade` or `--with-python`:

```bash
cd packages/sdk-python
.venv/bin/python3 scripts/generate.py
.venv/bin/python3 scripts/generate.py --check
```

If `.venv` is missing, fail-stop with the venv setup command from Prerequisites.
Do not invent alternate python binaries.

### Step 5 — Build the Models section

Prefer the newest history file under `packages/sdk/models/history/` whose
`timestamp=` is from this run (or the file `update-models` just printed).

Parse sections:

- `[added]` → ### Added models
- `[updated]` → ### Updated models
- `[removed]` → ### Removed models

**Bogus-history guard:** if `previous_count=0` **and** the `[added]` list is huge
relative to a normal incremental sync (e.g. hundreds of names when check-models
only reported a handful), **do not** paste the full history dump into the PR.
Fall back to:

1. Names printed by `check-models` / `update-models` console output, or
2. Diff-derived constant names from `git diff` on export lines in `models.ts`

Delete empty subsections. Validator requires **at least one** of Added /
Updated / Removed with a fenced code block.

### Step 6 — Commit (human-gated)

Present:

- Proposed commit message
- File list to stage

Default message shapes:

```text
feat[mod]: sync model constants from registry
```

With ticket in branch/PR title later; commit format is `prefix[tags]: subject`
(no ticket in commit). If the user wants the ticket in the commit subject, still
keep valid commit format (ticket belongs in the **PR title**).

Ask: "Commit these files?" — only then:

1. Stage exactly the expected dirty files.
2. Commit with the approved message (use a temp file for `-F` if needed; follow
   repo bash rules when operating in constrained shells).
3. `git status` to verify clean expected state.

### Step 7 — Open PR (unless `--no-pr`)

Chain into `qv-sdk-pr-create` (read that skill and follow it), with these
overrides already decided:

- **Tag:** `[mod]` required
- **Prefix:** usually `feat`
- **Title:** `TICKET feat[mod]: sync model constants from registry` (or
  `feat[mod|notask]: …` when `--notask`)
- **Models section:** use the section built in Step 5
- **What problem:** registry has newer models than the committed SDK catalog;
  consumers need updated compile-time constants
- **How it solves:** regenerated `models.ts` (+ contract / cascade artifacts)
  via `bun run update-models`
- **Testing:** `bun run check-models` (exit 0 after regen); `bun run contract:check`;
  note cascade checks if run

Still ask before `git push` / `gh pr create` (pr-create’s confirmation step).

After success, print the clickable PR URL.

## Commit / PR format reminders

- Commits: `feat[mod]: subject`
- PRs: `QVAC-123 feat[mod]: subject` or `feat[mod|notask]: subject`
- `[mod]` body must include `## 📦 Models` with at least one of Added / Updated /
  Removed (fenced constant names, one per line)
- Keep this PR to model catalog sync — don’t mix `[api]` / `[bc]` into a pure
  model-sync PR (combine tags with `|` when needed, e.g. `[mod|notask]`)

Validate locally when useful:

```bash
node scripts/sdk/validator.cjs --type=commit --msg="feat[mod]: sync model constants from registry"
```

## Efficiency rules

- Bound shell calls (~8–12 for a full cascade + PR). Cache `git status` / remotes.
- Do not re-run `update-models` if the tree already has a fresh regen from this
  session unless the user asks to re-fetch.
- Prefer Read/Grep tools over shell for inspecting history files and diffs.

## Quality checklist

Before reporting done:

- [ ] User confirmed regen (and commit / PR when applicable)
- [ ] `bun run check-models` exits 0 after regen (re-run once to confirm)
- [ ] `bun run contract:check` exits 0
- [ ] Dirty files ⊆ expected file set for the flags used
- [ ] History/Models section is incremental — not a bogus full-catalog dump
- [ ] Cascade checks passed when flags requested
- [ ] Commit message and PR title pass format rules
- [ ] PR URL printed (unless `--no-pr` / `--check-only`)
- [ ] Provenance: PR body or chat notes that `/qv-sdk-update-models` produced the work

## What this skill does NOT do

- Does not upload models to the registry (that is registry/CI writer flow).
- Does not bump package versions or cut releases.
- Does not sync `bare-sdk` deps (only relevant if `package.json` deps change —
  not part of a pure model regen).
- Does not modify naming / companion / shard codegen.
- Does not approve the `fork-ci` environment on fork PRs.

## References

- Script entry: `packages/sdk/package.json` → `update-models` / `check-models`
- Implementation: `packages/sdk/models/update-models/`
- Knowledge: `packages/ocr-ggml/.agent/knowledge/registry-models.md` (Step 4)
- Model constants docs: `.cursor/rules/sdk/docs/model-constants-and-sources.mdc`
- PR format: `.cursor/rules/sdk/commit-and-pr-format.mdc`
- PR create: `.cursor/skills/qv-sdk-pr-create/SKILL.md`
- Provider codegen: `packages/ai-sdk-provider/models/update-models/README.md`
- Python codegen: `packages/sdk-python/scripts/generate.py`
- Agentic automation: `.cursor/rules/devops/agentic-automation.mdc`
