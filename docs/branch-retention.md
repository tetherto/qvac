# Branch Retention & Deletion Policy

This document defines **which branches in the upstream org repo are kept, which are
eligible for deletion, and how the deletion is enforced**. It is the canonical,
portable policy for **all qvac repos** (the monorepo and the single-package repos).

It builds on the branch model defined in [gitflow.md](gitflow.md). Read that first
for branch *types* and *naming*; this document only covers *retention*.

## Table of contents

- [Scope](#scope)
- [Safelist (never delete)](#safelist-never-delete)
- [Why deleting release branches is safe](#why-deleting-release-branches-is-safe)
- [Release branches (nested semver retention)](#release-branches-nested-semver-retention)
- [Feature & temp branches](#feature--temp-branches)
- [Ad-hoc maintainer branches](#ad-hoc-maintainer-branches)
- [Activity measurement](#activity-measurement)
- [Enforcement](#enforcement)
- [Adopting this policy in another qvac repo](#adopting-this-policy-in-another-qvac-repo)
- [Note on the Assistant app](#note-on-the-assistant-app)
- [Open question: reducing backmerge pain](#open-question-reducing-backmerge-pain)

---

## Scope

- **Applies only to branches in the upstream org repo** (the "Tether" repo, e.g.
  `tetherto/qvac`).
- **Contributor fork branches are out of scope** — we cannot (and should not) delete
  branches in someone else's fork.
- Branch types are those defined in [gitflow.md](gitflow.md): `main`, `release-*`,
  `feature-*`, `tmp-*`. Anything else is treated as an **ad-hoc** branch.
- The release rule applies to **both** naming schemes:
  - monorepo: `release-<package>-<x.y.z>`
  - single-package repo: `release-<x.y.z>`

---

## Safelist (never delete)

A branch is **never** deleted, regardless of age or version, if any of the following
holds:

- It is `main`.
- It backs the **current latest published version** for a package (see
  [enforcement](#enforcement) for how "latest published" is determined — from the
  release git tags, not an external registry).
- It is the **head or base of an open / unmerged PR** (active until the PR is merged or
  closed).
- It is under **active branch protection** or is used as a **required CI status
  target** (detected via the branch's `protected` flag / branch-protection rules).
- It is flagged **WIP**.

> **WIP naming caveat.** Git ref names cannot contain `[` or `]`, so a literal
> `[WIP]` branch name is impossible. The enforcement tool instead treats a branch as
> WIP-flagged when its name contains a case-insensitive `wip` token (e.g.
> `wip/...`, `feat/wip-...`). Use that form to opt a branch out of cleanup by name.

---

## Why deleting release branches is safe

On merge to a `release-*` branch, CI:

1. publishes the package to **NPM**, and
2. creates a git tag `<package>-v<x.y.z>` (single-package repos: `v<x.y.z>`) **and** a
   GitHub release.

See [`create-github-release.yml`](../.github/workflows/create-github-release.yml).

The shipped code is therefore preserved **permanently** by the tag and the npm
artifact. Deleting a `release-*` branch loses **no history** — the branch is only a
movable pointer; the tag is the immutable record.

---

## Release branches (nested semver retention)

Evaluated **per package**, using a nested semver window:

- Keep the latest **2 major** lines (current + previous major).
- Within each retained major, keep the latest **3 minor** lines.
- Within each retained minor, keep the latest **1 patch** line.

Anything older than this window is **eligible for deletion** (subject to the
[safelist](#safelist-never-delete) and the [grace period](#enforcement)).

> Release-branch eligibility is **purely** semver-window based — there is no
> inactivity requirement for release branches. The safelist (open PR, latest-published
> tag) still protects the lines you actually depend on.

**Example** — package currently at `release-pkg-3.4.7`:

- Keep majors **3** and **2**.
- In major 3, keep minors **3.4 / 3.3 / 3.2**.
- In `3.4`, keep patch **3.4.7** only.
- `release-pkg-3.4.6`, `release-pkg-3.1.x`, `release-pkg-1.x.x`, etc. are eligible.

**`0.x` lines** are handled by the same "latest 2 majors" rule, with `0` counted as a
major. They are retained until the package is two majors ahead (i.e. a `2.x` exists),
at which point `0` drops out of the top-2-majors window and becomes eligible.

**Prerelease lines** (`next` / `beta`, and any `x.y.z-<pre>`) are **not** retained as
long-lived branches. They never back the stable `latest` tag, so they are cleaned up
like [temp branches](#feature--temp-branches) (deleted after inactivity).

---

## Feature & temp branches

- `feature-*` — delete after **2 months** of inactivity.
- `tmp-*` — delete after **2 months** of inactivity.

---

## Ad-hoc maintainer branches

Anything that does not match the named types above (`main`, `release-*`, `feature-*`,
`tmp-*`) is an **ad-hoc** branch — delete after **1 month** of inactivity.

---

## Activity measurement

A branch's **last activity** is the most recent of:

- the **last commit** on the branch, or
- the **last comment** on its related PR.

A branch with an **open PR is always considered active** (it is also on the safelist
above).

---

## Enforcement

A scheduled GitHub Action runs **weekly** and operates in two phases so that nothing is
deleted without warning:

1. **Compute** the deletion candidates per the rules above.
2. **Notify** — maintain a single tracking issue (labelled `branch-cleanup`) that lists
   every current candidate together with the date it was **first flagged** and the
   reason. The issue is the durable ledger between runs (GitHub Actions are otherwise
   stateless).
3. **Grace period** — a candidate is only deleted once it has been **continuously
   flagged for ~7 days** *and* is still a candidate. If a branch stops being a candidate
   in the meantime (new activity, a PR opens, it gets safelisted), it is removed from
   the ledger ("reprieved") and the clock resets.
4. **Delete** — eligible branches are deleted and recorded in the tracking issue, and a
   run-summary comment is posted.

**Maintainer ack** (optional, via comments on the tracking issue):

- `keep: <branch>` — exempt a branch from cleanup (persisted in the ledger).
- `delete-now: <branch>` — skip the remaining grace period for a branch.

**Safety rails:**

- A **dry-run** mode performs every step *except* the deletion, for verification.
- A **max-deletions-per-run** cap guards against a logic bug deleting many branches at
  once.
- Protected branches and `main` can never be selected, by construction.
- **Issues must be enabled** (the tracking issue is the grace-period ledger). If Issues
  are disabled in a repo, the workflow runs in **report-only mode** — it logs the
  candidate list but deletes nothing.

Implementation lives in:

- [`.github/workflows/branch-cleanup.yml`](../.github/workflows/branch-cleanup.yml) —
  this repo's scheduled caller.
- [`.github/workflows/reusable-branch-cleanup.yml`](../.github/workflows/reusable-branch-cleanup.yml)
  — the reusable (`workflow_call`) workflow other repos invoke.
- [`.github/actions/branch-cleanup/`](../.github/actions/branch-cleanup/) — composite
  action carrying the core logic (`branch-cleanup.mjs`). It is referenced as a
  composite action so it resolves cross-repo via org action sharing, without needing
  a cross-repo checkout token in the consuming repo.

---

## Adopting this policy in another qvac repo

Other qvac repos do **not** copy the logic. They add a thin caller workflow that
invokes the reusable workflow hosted here. Because a reusable workflow runs with the
**caller's** repository context, all branch/PR/tag operations target the calling repo
automatically.

```yaml
# .github/workflows/branch-cleanup.yml in the consuming repo
name: Branch cleanup
on:
  schedule:
    - cron: "0 8 * * 1" # weekly, Monday 08:00 UTC (09:00 CET)
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Report only; do not delete"
        type: boolean
        default: true

permissions:
  contents: read

concurrency:
  group: branch-cleanup
  cancel-in-progress: false

jobs:
  cleanup:
    uses: tetherto/qvac/.github/workflows/reusable-branch-cleanup.yml@main
    permissions:
      contents: write
      issues: write
      pull-requests: read
    with:
      dry_run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}
      single_package: true # single-package repos use release-<x.y.z> / v<x.y.z>
```

**Tunable inputs** (all optional, with the defaults below):

| Input | Default | Meaning |
|---|---|---|
| `dry_run` | `false` | Report only; never delete. |
| `single_package` | `false` | `true` for single-package repos (`release-<x.y.z>`, tag `v<x.y.z>`); `false` for the monorepo (`release-<pkg>-<x.y.z>`, tag `<pkg>-v<x.y.z>`). |
| `grace_period_days` | `7` | Days a branch must stay flagged before deletion. |
| `keep_majors` | `2` | Major lines retained per package. |
| `keep_minors` | `3` | Minor lines retained per kept major. |
| `keep_patches` | `1` | Patch lines retained per kept minor. |
| `feature_inactivity_days` | `60` | `feature-*` inactivity threshold. |
| `tmp_inactivity_days` | `60` | `tmp-*` inactivity threshold. |
| `adhoc_inactivity_days` | `30` | ad-hoc branch inactivity threshold. |
| `max_deletions_per_run` | `10` | Hard cap on deletions in a single run. |

---

## Supply chain & versioning

This is a **deliberate single mutable supply chain** anchored on `tetherto/qvac`:

- Consuming repos call the reusable workflow `@main`, and the reusable workflow in turn
  references the composite action `@main`. There is intentionally **no SHA pin** on the
  inner action.
- The rationale: `tetherto/qvac` is the single source of truth for the cleanup logic, and
  every change to it is gated by this repo's **branch protection + PR review** (TIER1
  approvals). That review gate — not a per-consumer pin — is the control point. A
  SHA-pinned inner action would not change the consumer's exposure either, because the
  consumer already floats on the reusable workflow `@main`.
- The trade-off, made consciously: a merge to `tetherto/qvac` `main` immediately changes
  the branch-deletion logic running in every consuming repo. This is acceptable because
  (a) the logic is reviewed here before it can land, (b) the destructive surface is
  bounded by the safelist, the ~7-day grace ledger, the `max_deletions_per_run` cap, and
  dry-run/report-only fallbacks, and (c) deleted release branches are recoverable from
  their tags.
- A repo that wants an immutable pin instead can call the reusable workflow at a SHA/tag
  (`...@<sha>`); it then opts out of automatic logic updates and owns bumping the ref.

---

## Note on the Assistant app

The QVAC Assistant is an **application**, not a library package, and lives in its own
repository with an **app-specific gitflow** documented there. This retention policy
governs the library/model package repos; it does **not** govern the Assistant app's
branch model.

---

## Open question: reducing backmerge pain

> This section is an open discussion item, not yet a decision. The retention policy
> above reduces the count of *stale* release branches, but it does not address the
> *backmerge* friction that release branches create in the first place. The two are
> related halves of the same problem and worth deciding together.

In the fork-first monorepo, every release that is not prepped on `main` first needs a
follow-up "backmerge" PR to keep `main` aligned with the shipped version/changelog
(see [gitflow.md](gitflow.md) "Keep `main` aligned"). This is repetitive, easy to
forget, and a source of noise. Options to discuss with the team:

1. **Prep release metadata on `main` first (process discipline).** Cut the release
   branch from a `main` that already carries the intended version bump + changelog, so
   the backmerge is a guaranteed no-op. Already the "preferred" path in
   [gitflow.md](gitflow.md); the cost is up-front coordination. Lowest tooling effort.
2. **Automated backmerge bot.** Promote the existing
   [`qv-sdk-backmerge`](../.cursor/skills/qv-sdk-backmerge/SKILL.md) skill logic into a
   CI workflow that opens (or auto-merges, where safe) the `[skiplog]` backmerge PR on
   every release publish. Removes the manual step; cost is conflict-handling and the
   blast radius of an automated merge into `main`.
3. **Release-from-tag instead of long-lived release branches.** Publish from an
   ephemeral, tag-anchored ref so there is no durable `release-*` branch to diverge from
   `main` and therefore nothing to backmerge. Biggest change to the release model;
   needs its own proposal (likely a QIP) and CI rework.

Recommended next step: socialise these options with the devs, pick a direction, and —
if it changes the release flow materially — capture it as a QIP before implementing.
