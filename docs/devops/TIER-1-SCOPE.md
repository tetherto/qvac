# Tier-1 scope

Tier-1 is the small, agreed set of repos and surfaces that DevOps actively
enforces policy on. Everything outside Tier-1 is best-effort until a later
quarter. Downstream enforcement tickets reference this doc instead of
re-litigating scope per ticket.

> **Status: partial (enforcement-surface stub).** This file currently captures
> the enforcement surfaces needed by in-flight Q3 gates (§B). The full Tier-1
> scope lock — the complete repo list, critical systems, public repo list, and
> mobile signing scope — is owned by QVAC-19052; expand §A there. Sections are
> lettered/numbered so tickets can cite a stable anchor (e.g. "§B1").

## §A — Tier-1 repos

Pilot repo for the Q3 enforcement gates:

- **`tetherto/qvac`** — the QVAC monorepo. Ships the SDK, CLI, and inference
  addons to users and holds release/publish paths, so it is the first Tier-1
  repo the enforcement gates target.

The remaining Tier-1 repo list, critical systems, public repo list, and mobile
signing scope are defined by QVAC-19052 and land here when locked.

## §B — Enforcement surfaces on Tier-1

Deterministic, PR-time supply-chain / compliance gates. Each is a thin caller in
the consumer repo delegating to a canonical reusable workflow in
`tetherto/qvac-actions`.

### §B1 — License / compliance

**Goal:** a disallowed license (e.g. AGPL, SSPL, GPL on a runtime path) or a
missing third-party/model attribution is caught in CI before merge, not by a
human remembering to run a checklist.

- **Gate (primary):** [`.github/workflows/license-compliance.yml`](../../.github/workflows/license-compliance.yml)
  → `tetherto/qvac-actions/.github/workflows/public-reusable-license.yml`.
  - Engine A: dependency license policy (allow / deny / review) + lockfile drift
    over the PR dependency diff.
  - Engine B: advisory NOTICE/attribution presence check.
  - Severity matrix, exception flow, and SKILL fallback are specified in
    `tetherto/qvac-actions/docs/license-compliance-ci.md` (the approved design
    doc, QVAC-19057).
- **Exceptions:** [`.github/license-allowlist.yml`](../../.github/license-allowlist.yml),
  CODEOWNERS-protected; plus a one-off `license-override` PR label
  (High findings only). See [`docs/ci/LABELS.md`](../ci/LABELS.md).
- **Fallback:** the `qv-notice-generate` compliance SKILL
  ([`.cursor/skills/qv-notice-generate`](../../.cursor/skills/qv-notice-generate/SKILL.md))
  handles the long tail the gate cannot classify and full transitive audits.
- **Coverage limitation:** package lockfiles are gitignored in `qvac`, so the
  gate reads a manifest-only dependency graph and classifies **direct/declared
  deps only, not the full transitive tree** — a disallowed transitive license
  can still pass. Full transitive coverage is the SKILL fallback's job. Resolve
  (commit lockfiles or schedule a SKILL audit) before promoting this gate from
  warn-only to a required blocking check.
- **Rollout stage:** **warn-only (shadow mode)** — annotates PRs without
  blocking. Promotion to a required blocking status check is a follow-up, gated
  on shadow-mode telemetry (false-positive rate, time-to-resolve) and TL
  sign-off, per the design doc's rollout sequencing. Owned by QVAC-21554.

### §B2 — Security baseline

TruffleHog secret scanning + CodeQL static analysis, via
[`.github/workflows/security-baseline.yml`](../../.github/workflows/security-baseline.yml)
→ `public-reusable-security.yml`. Rolled out under QVAC-21550; documented in
`tetherto/qvac-actions/docs/security-baseline.md`. Listed here for context — it
is the sibling pillar the license gate is modeled on.

### §B4 — Workflow security

**Goal:** the repo's own GitHub Actions definitions can't silently regress into
the high-risk patterns the DevOps rules forbid — template injection, dangerous
triggers / "pwn requests", unpinned action refs, excessive permissions, cache
poisoning, credential persistence — caught in CI when a workflow/action changes
instead of only by a human running the `qv-devops-pr-review` checklist. This is
the workflow-hardening sibling of the §B2 security baseline (which scans repo
*source*; this scans repo *CI*).

- **Gate:** [`.github/workflows/workflow-security.yml`](../../.github/workflows/workflow-security.yml).
  Runs [`zizmor`](https://docs.zizmor.sh) static analysis over the `.github/`
  tree (workflows + composite actions). The audited patterns map onto the
  A1–A15 checklist in
  [`.cursor/skills/qv-devops-pr-review`](../../.cursor/skills/qv-devops-pr-review/SKILL.md),
  which stays the human fallback for the repo-specific conventions zizmor does
  not model (mandatory `harden-runner`, the `# v<ver>` pin comment, per-job
  `timeout-minutes`, filename conventions).
- **In-repo, not a `qvac-actions` reusable workflow:** like the in-repo NOTICE
  drift gate (QVAC-21558, landing as §B3), it audits this repo's `.github/` tree
  with a repo-pinned engine and repo-specific rollout semantics, rather than
  delegating like the §B1/§B2 thin callers. If the org later publishes a
  `public-reusable-workflow-security.yml` this can shrink to a thin caller.
- **Secrets:** none. zizmor runs `--offline`, so the gate needs no token and runs
  on fork PRs too (a fork can change a workflow). Only the PR-comment step is
  gated to same-repo PRs; fork PRs rely on the inline annotations and job
  summary.
- **Engine pin:** zizmor is pinned to a fixed version (freeze-and-pin, like the
  reusable-workflow SHA pins) so results are deterministic — a zizmor bump can
  add or drop findings, so version changes are deliberate.
- **Coverage limitation:** `--offline` skips the online-only audits
  (impostor-commit detection, action-ref resolution). Promotion to online mode
  (read-only `GITHUB_TOKEN`) is a follow-up. Separately, the `pull_request`
  `paths` filter means the job never starts on PRs that touch no workflow/action
  files — correct in shadow mode, but a *required* path-filtered check stays
  permanently "pending" on unrelated PRs, so promotion to blocking must add a
  required-check shim or drop the path filter.
- **Existing backlog / noise:** the first audit over the current `.github/` tree
  reports ~1,250 findings (the `regular` persona already suppresses ~1,450 more),
  including a few hundred `high`. This is the pre-existing debt shadow mode exists
  to surface and burn down — it is why the gate never blocks on day one. The gate
  audits the *whole* tree on every run, so a PR touching one workflow still
  surfaces the repo-wide backlog; scoping PR-time feedback to the changed
  workflow/action files (and/or a `.github/zizmor.yml` ignore policy for accepted
  findings) is a triage follow-up that must precede promotion to blocking.
- **Rollout stage:** **warn-only (shadow mode)** — annotates the PR inline, in
  the job summary, and via a single upserted PR comment, but never blocks.
  `workflow_dispatch` with `enforce=true` flips findings (and tool errors) into
  hard failures for a blocking trial. Promotion to a required blocking check is a
  follow-up, gated on shadow-mode telemetry (false-positive rate,
  time-to-resolve) plus TL sign-off.
- **Rolled out under QVAC-21551.**
