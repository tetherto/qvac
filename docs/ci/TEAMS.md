# GitHub Teams — CI access reference

Single source of truth for the GitHub teams that govern access, review, and CI authorisation in `tetherto/qvac`.

> **Membership** — this doc names the teams and what they can do. The authoritative member list lives at <https://github.com/orgs/tetherto/teams> and is managed via GitHub. Don't enumerate names here; they drift.

---

## Team summary

| Team | Tier | Repo permission | Primary CI privilege |
|---|---|---|---|
| `@tetherto/qvac-internal-dev` | Internal | Write | Apply `verified` to authorise secret-bearing PR jobs |
| `@tetherto/qvac-internal-merge` | Internal | Write + merge | Tier-1 approver for `approval-check-worker`; can apply `verified` |
| `@tetherto/qvac-internal-release` | Internal | Maintain | npm publish reviewer (`npm` environment); can apply `verified` |
| `@tetherto/qvac-external` | External | Triage | Open PRs from forks; cannot apply `verified` directly |

---

## `@tetherto/qvac-internal-dev`

**Purpose**: Day-to-day Tether engineers contributing to QVAC packages.

**Responsibilities**
- Open PRs against `main` (fork-first per [`docs/gitflow.md`](../gitflow.md)).
- Apply `verified` to other engineers' PRs after a quick sanity check that the PR is from a known author and the workflow changes are non-malicious. The label is the entry point for secret-bearing CI; treat applying it as a security action.
- Respond to CI failures on your own PRs.

**Repo permission**: Write — can push to feature branches, cannot merge to `main` (CODEOWNERS gates that).

**Recognised by**
- `label-gate` composite action — default `teams` input includes this team.
- `approval-worker.yml` / `approval-check-worker.yml` — counts toward team-member approvals.

**Escalation**
- Cannot reach a tier-1 approver → ping `@tetherto/qvac-internal-merge` in the PR thread.
- Need to publish a package → see [Release flow](#-tetherto-qvac-internal-release).

---

## `@tetherto/qvac-internal-merge`

**Purpose**: Tier-1 reviewers / merge approvers. Subset of internal engineers trusted to sign off on merges to `main`.

**Responsibilities**
- Tier-1 review on PRs (counts as one approval per `approval-check-worker.yml`).
- Apply `verified` when a PR is ready for full CI to run.
- Resolve merge conflicts on long-running PRs.

**Repo permission**: Write + merge to `main` (via CODEOWNERS in `.github/CODEOWNERS`).

**Recognised by**
- `label-gate` — included in default `teams` input.
- `approval-check-worker.yml` — explicitly checked as `teamLeads` (line 170 in the worker), so a single review from this team satisfies the tier-1 requirement.

**Escalation**
- Disputed review → take to the PR author + the relevant pod lead in `.github/teams/<pod>.json`.
- Need release sign-off (npm publish, `release-*` branch ops) → defer to `@tetherto/qvac-internal-release`.

---

## `@tetherto/qvac-internal-release`

**Purpose**: Release approvers. Sign off on npm publishes and release-branch operations.

**Responsibilities**
- Click "Approve and deploy" on the `npm` GitHub Actions environment when a publish job is queued. Each `@qvac/*` package's npm Trusted Publisher is configured to require this environment, so this is the authoritative npm-publish gate.
- Approve PRs into `release-<package>-<x.y.z>` branches.
- Apply `verified` like any other internal engineer when approving routine PRs (no special distinction for the gate itself).
- Cut new release branches per [`docs/gitflow.md`](../gitflow.md).

**Repo permission**: Maintain — can manage releases, edit branch protection on release branches, and serve as the named reviewer on the `npm` environment.

**Recognised by**
- `label-gate` — included in default `teams` input.
- `npm` GitHub Actions environment — listed as required reviewer for every npm publish job.
- `release` GitHub Actions environment — historically the gate for release jobs; reviewer requirement removed once the `verified` flow is fully validated in production (tracked under QVAC-18190).

**Escalation**
- Compromised publish (wrong version, leaked credentials) → unpublish + rotate `NPM_TOKEN` immediately + post in `#qvac-devops`.
- npm Trusted Publisher misconfig → coordinate with the package author + DevOps pod (`.github/teams/devops.json`).

---

## `@tetherto/qvac-external`

**Purpose**: External contributors and contractors. Includes anyone who isn't on a Tether-internal team.

**Responsibilities**
- Open PRs from forks per [`docs/gitflow.md`](../gitflow.md).
- Respond to review feedback and CI failures.

**Repo permission**: Triage — can label/assign issues, cannot push or merge.

**Recognised by**
- `label-gate` — **NOT** in the default `teams` input. External contributors cannot self-authorise their own secret-bearing CI; an internal team member must apply `verified`.
- Approval bot — does not count toward tier-1 approval.

**Escalation**
- CI not running on your PR → an internal reviewer needs to apply `verified`. Comment on the PR or ping in `#qvac-devops`.
- Found a security issue → report via the `tetherto/qvac` security advisory flow, not as a public PR.

---

## Pod ownership (sub-grouping)

Pods are smaller, package-scoped groups inside the internal teams. They drive CODEOWNERS routing and pod-specific cursor rules but do not themselves grant CI access.

| Pod | Owned paths | Metadata |
|---|---|---|
| DevOps | `.github/workflows/`, `.github/actions/`, `.github/scripts/`, `scripts/` | [`.github/teams/devops.json`](../../.github/teams/devops.json) |
| SDK | `packages/sdk/`, `packages/cli/`, `packages/rag/`, `packages/logging/`, `packages/error/` | [`.github/teams/sdk.json`](../../.github/teams/sdk.json) |

Pod members are still part of one of the umbrella teams above (typically `qvac-internal-dev`). The pod metadata governs *who reviews changes to which paths* via CODEOWNERS, not *who can authorise secret-bearing CI*.

---

## See also

- [`docs/ci/LABELS.md`](LABELS.md) — labels recognised by CI, including the `verified` security gate.
- [`.github/CODEOWNERS`](../../.github/CODEOWNERS) — path-to-team review routing.
- [`.github/actions/label-gate/README.md`](../../.github/actions/label-gate/README.md) — full trust model for the `verified` gate.
- [`docs/gitflow.md`](../gitflow.md) — branch model and release flow.
