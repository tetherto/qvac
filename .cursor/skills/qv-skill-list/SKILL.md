---
name: qv-skill-list
description: Catalog of all repo qv-* custom skills with one-line purpose and when-to-use. Use when the user asks what skills exist, which skill to use, how to invoke a skill, or invokes /qv-skill-list.
---

# QVAC Custom Skills Catalog

All custom repo skills live under `.cursor/skills/` and use the `qv-` prefix. Invoke with `/qv-<name>` in chat.

**Not listed here (by design):**

- [`setup`](../setup/SKILL.md) — repo-wide bootstrap (`/setup`); copies shared config from `packages/ocr-onnx/.agent/` into `.claude/` and `.cursor/`.
- `packages/ocr-onnx/.agent/skills/` — framework skills (`orchestrate`, `release`, `ci-validate`, `commit-trace`, `review`); installed by `/setup`, not `qv-*` prefixed.

## How to invoke

| Mode | Behavior |
|------|----------|
| **Auto-invokable** | No `disable-model-invocation` in frontmatter — the agent may load the skill when your request matches the description. |
| **Manual only** | `disable-model-invocation: true` — invoke explicitly with `/qv-<name>` (or ask the agent to run that skill). |

When unsure which skill fits, scan the tables below or ask: *"which qv skill should I use for …?"*

---

## PR workflow (cross-pod)

| Skill | Purpose | Use when |
|-------|---------|----------|
| [`qv-pr-review`](../qv-pr-review/SKILL.md) | Deep PR review: gitflow, CI, format, code quality, security; posts a PENDING GitHub review with inline comments. | Reviewing any PR, given a PR URL, or follow-up from a pod status/my skill. **Manual:** `/qv-pr-review` |
| [`qv-pr-test`](../qv-pr-test/SKILL.md) | Plan and run local PR validation; discovers packages/scripts, recommends test tier, analyzes results. | Testing a PR locally before merge. **Manual:** `/qv-pr-test` |
| [`qv-pr-mine`](../qv-pr-mine/SKILL.md) | Your open PRs across all pods, merge readiness, Slack ping messages for reviewers. | "What are my PRs?", merge readiness, who to ping. **Manual:** `/qv-pr-mine` |

---

## DevOps pod

| Skill | Purpose | Use when |
|-------|---------|----------|
| [`qv-devops-pr-create`](../qv-devops-pr-create/SKILL.md) | PR titles and bodies for CI/CD, composite actions, automation, IaC. | Creating a DevOps PR. **Manual:** `/qv-devops-pr-create` |
| [`qv-devops-pr-review`](../qv-devops-pr-review/SKILL.md) | `/qv-pr-review` plus GitHub Actions security audit (pinning, permissions, OIDC, secrets). | Reviewing PRs that touch DevOps paths. **Manual:** `/qv-devops-pr-review` |
| [`qv-devops-pr-status`](../qv-devops-pr-status/SKILL.md) | Team DevOps PR dashboard: re-review, stale, needs-review, conflicts. | DevOps pod PR queue health. **Manual:** `/qv-devops-pr-status` |
| [`qv-devops-why-my-pr-not`](../qv-devops-why-my-pr-not/SKILL.md) | Diagnose missing CI checks or merge blockers (labels, CODEOWNERS, approvals). | "Why aren't checks running?" / "Why can't I merge?" **Manual:** `/qv-devops-why-my-pr-not` |
| [`qv-devops-daily-update`](../qv-devops-daily-update/SKILL.md) | Slack standup (Done / Planned / Blockers) from PRs, reviews, CI. | DevOps EOD or standup. **Manual:** `/qv-devops-daily-update` |

---

## SDK pod

| Skill | Purpose | Use when |
|-------|---------|----------|
| [`qv-sdk-pr-create`](../qv-sdk-pr-create/SKILL.md) | PR descriptions for SDK pod packages (`sdk`, `cli`, `rag`, `logging`, `error`). | Creating an SDK pod PR; may chain to backmerge. **Auto** |
| [`qv-sdk-pr-status`](../qv-sdk-pr-status/SKILL.md) | Team SDK pod PR dashboard. | SDK pod PR queue. **Manual:** `/qv-sdk-pr-status` |
| [`qv-sdk-changelog`](../qv-sdk-changelog/SKILL.md) | Changelogs for SDK pod packages (tag-based GitFlow). | Release prep, `CHANGELOG_LLM.md`. **Auto** |
| [`qv-sdk-backmerge`](../qv-sdk-backmerge/SKILL.md) | Open backmerge PR (release version bump + changelog → `main`). | After SDK release PR; often chained from `qv-sdk-pr-create`. **Auto** |
| [`qv-sdk-e2e-create`](../qv-sdk-e2e-create/SKILL.md) | Scaffold e2e tests in `packages/sdk/e2e` for new/changed public APIs. | Adding consumer-facing SDK APIs. **Auto** |

---

## Addon pod (native inference / decoder / OCR)

| Skill | Purpose | Use when |
|-------|---------|----------|
| [`qv-addon-changelog`](../qv-addon-changelog/SKILL.md) | Changelog entries for a target add-on package. | Add-on release prep. **Auto** |
| [`qv-addon-pr-create`](../qv-addon-pr-create/SKILL.md) | PR descriptions for non-SDK inference addons, decoder, OCR. | "Prepare PR description" for an addon. **Auto** |
| [`qv-addon-release-notes`](../qv-addon-release-notes/SKILL.md) | Release notes for addon packages. | Addon release notes. **Auto** |

---

## Registry server

| Skill | Purpose | Use when |
|-------|---------|----------|
| [`qv-registry-autobase-patterns`](../qv-registry-autobase-patterns/SKILL.md) | Autobase, HyperDB, multi-writer patterns, replication debugging. | Registry server, Autobase/HyperDB schemas, Corestore issues. **Auto** |

---

## Developer diary and standup

| Skill | Purpose | Use when |
|-------|---------|----------|
| [`qv-dev-diary-setup`](../qv-dev-diary-setup/SKILL.md) | Opt-in local dev diary (`~/.config/qvac-pr-skills/`). | Enable diary, `diary --init`, configure capture. **Manual:** `/qv-dev-diary-setup` |
| [`qv-dev-diary`](../qv-dev-diary/SKILL.md) | Read, inspect, append diary entries. | View today's log, add notes after setup. **Manual:** `/qv-dev-diary` |
| [`qv-daily-work-update`](../qv-daily-work-update/SKILL.md) | Personal EOD update from diary + GitHub + PR state (+ optional Asana). | Personal standup / "what did I do today". **Manual:** `/qv-daily-work-update` |
| [`qv-asana-sync`](../qv-asana-sync/SKILL.md) | Look up and update Asana tasks (status, comments, PR links). | Sync Asana task, move status, validate config. **Manual:** `/qv-asana-sync` |

---

## Ecosystem and compliance

| Skill | Purpose | Use when |
|-------|---------|----------|
| [`qv-holepunch-dev`](../qv-holepunch-dev/SKILL.md) | Holepunch/P2P/Bare/Pear API discovery via docs.pears.com and `gh`. | Hypercore, Hyperswarm, Autobase, Bare, Pear development. **Auto** |
| [`qv-notice-generate`](../qv-notice-generate/SKILL.md) | NOTICE files and third-party attributions for monorepo packages. | License compliance, release NOTICE updates. **Auto** |

---

## Quick picker

| You want to… | Skill |
|--------------|-------|
| Review any PR | `qv-pr-review` |
| Review a DevOps/CI PR | `qv-devops-pr-review` |
| Test a PR locally | `qv-pr-test` |
| See your open PRs | `qv-pr-mine` |
| SDK team PR board | `qv-sdk-pr-status` |
| DevOps team PR board | `qv-devops-pr-status` |
| Why CI/merge is blocked | `qv-devops-why-my-pr-not` |
| Write SDK PR body | `qv-sdk-pr-create` |
| Write addon PR body | `qv-addon-pr-create` |
| SDK release changelog | `qv-sdk-changelog` |
| Addon release changelog | `qv-addon-changelog` |
| Backmerge after SDK release | `qv-sdk-backmerge` |
| New SDK e2e tests | `qv-sdk-e2e-create` |
| Registry Autobase/HyperDB help | `qv-registry-autobase-patterns` |
| Holepunch stack help | `qv-holepunch-dev` |
| Generate NOTICE files | `qv-notice-generate` |
| List all skills | `qv-skill-list` (this file) |
