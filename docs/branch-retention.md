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
- [Other qvac repos](#other-qvac-repos)
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
- It is a **non-release** branch under **active branch protection** or used as a
  **required CI status target** (detected via the branch's `protected` flag /
  branch-protection rules). **Release branches are the exception:** many repos use a
  ruleset that marks *every* `release-*` branch protected purely for merge governance
  (PR review / status checks). That protection does **not** exempt an out-of-window
  release line from the [semver-window trim](#release-branches-nested-semver-retention)
  — those branches are tag-backed and safe to delete, so they are governed by the
  release rule (plus the latest-published / open-PR safelist), not by the `protected`
  flag. Deletion works because the merge-governance ruleset carries no *deletion* rule.
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

A central DevOps bot enforces this policy weekly across the qvac repos. Nothing is
deleted without warning:

1. **Compute** the deletion candidates per the rules above.
2. **Notify**: every candidate is tracked on a ledger issue with the date it was first
   flagged, and each weekly run reports what it flagged and deleted.
3. **Grace period**: a candidate is deleted only once it has been flagged for at least
   **7 days** and is still a candidate. A branch that stops being a candidate (new
   activity, an open PR, a safelist match) leaves the ledger and its clock resets.
4. **Delete**: eligible branches are deleted and each deletion is recorded with its SHA,
   so a branch can be restored with `git push origin <sha>:refs/heads/<branch>`.

**Maintainer acks** (comments on the ledger issue):

- `keep: tetherto/qvac#<branch>`: exempt a branch permanently.
- `delete-now: tetherto/qvac#<branch>`: skip the rest of its grace period.

**Safety rails:**

- `main`, the default branch and protected non-release branches are never selected.
  Release branches are kept by the retention window above, protected or not.
- A per-run deletion cap guards against a logic bug deleting many branches at once.
- Every commit pinned by a published `qvac-registry-vcpkg` port version is tagged
  (`vcpkg/<port>-<version>-pv<port-version>`) before anything is deleted, so pinned
  commits outlive their branches.

> **This repo runs a tighter window than the defaults:** the latest **2 minor** release
> lines per package (not 3), ad-hoc branches stale after **14 days**, and
> `feature-*`/`tmp-*` after **30 days**. These overrides are set in the bot's
> configuration.

---

## Other qvac repos

Coverage is managed centrally: a repo is added to the bot's scope, not given a workflow
of its own. Don't add a caller for `reusable-branch-cleanup.yml`: it would run a second
pruner with its own ledger and acks.

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
   [`qv-sdk-backmerge`](../.agents/skills/qv-sdk-backmerge/SKILL.md) skill logic into a
   CI workflow that opens (or auto-merges, where safe) the `[skiplog]` backmerge PR on
   every release publish. Removes the manual step; cost is conflict-handling and the
   blast radius of an automated merge into `main`.
3. **Release-from-tag instead of long-lived release branches.** Publish from an
   ephemeral, tag-anchored ref so there is no durable `release-*` branch to diverge from
   `main` and therefore nothing to backmerge. Biggest change to the release model;
   needs its own proposal (likely a QIP) and CI rework.

Recommended next step: socialise these options with the devs, pick a direction, and —
if it changes the release flow materially — capture it as a QIP before implementing.
