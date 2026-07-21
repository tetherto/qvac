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
