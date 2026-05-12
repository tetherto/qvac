# GitHub Teams — CI access reference

The four teams that show up in this repo's CI configuration. This doc names them and what they're for; everything else (membership, permission tiers, internal escalation, on-call) lives off-repo.

> **Membership and access** — managed in GitHub at <https://github.com/orgs/tetherto/teams>. This file does not enumerate members; the source of truth is GitHub.

---

## Teams

| Team | Purpose |
|---|---|
| `@tetherto/qvac-internal-dev` | Day-to-day Tether engineers contributing to QVAC packages. |
| `@tetherto/qvac-internal-merge` | Internal reviewers / merge approvers (tier-1 reviewer slot). |
| `@tetherto/qvac-internal-release` | Release approvers — sign off on npm publishes and `release-*` branch operations. |
| `@tetherto/qvac-external` | External contributors. Open PRs from forks; do not authorise secret-bearing CI. |

---

## Where each team is referenced in this repo

The trust model and access rules are encoded in the repo, not in this doc — read those files for the canonical behaviour:

- **Merge approval routing** → [`.github/CODEOWNERS`](../../.github/CODEOWNERS)
- **`verified` label / secret-bearing CI authorisation** → [`.github/actions/label-gate/README.md`](../../.github/actions/label-gate/README.md), [`.github/actions/label-gate/action.yml`](../../.github/actions/label-gate/action.yml) (default `teams` input)
- **Tier-1 / tier-2 review computation** → [`.github/workflows/approval-check-worker.yml`](../../.github/workflows/approval-check-worker.yml)
- **Pod-scoped path ownership** → [`.github/teams/devops.json`](../../.github/teams/devops.json), [`.github/teams/sdk.json`](../../.github/teams/sdk.json)
- **Branch model + release flow** → [`docs/gitflow.md`](../gitflow.md)

---

## Pod ownership

Pods are smaller, package-scoped groupings inside the umbrella teams. They drive CODEOWNERS routing and pod-specific cursor rules; they do not themselves grant CI access.

| Pod | Owned paths | Metadata |
|---|---|---|
| DevOps | `.github/workflows/`, `.github/actions/`, `.github/scripts/`, `scripts/` | [`.github/teams/devops.json`](../../.github/teams/devops.json) |
| SDK | `packages/sdk/`, `packages/cli/`, `packages/rag/`, `packages/logging/`, `packages/error/` | [`.github/teams/sdk.json`](../../.github/teams/sdk.json) |

---

## See also

- [`docs/ci/LABELS.md`](LABELS.md) — labels recognised by CI, including the `verified` security gate.
