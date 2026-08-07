# Agentic CI pilot charter

A bounded, approval-gated charter for piloting **one** agentic workflow in CI on
**one** repo. QVAC has a mature *local* (interactive, human-in-the-loop) agent
framework, but — apart from a single dormant job (§1) — nothing agentic runs in
GitHub Actions today. This document is the decision artifact that authorizes a
narrow pilot, fixes its guardrails, and defines how we decide whether to keep,
iterate on, or kill it. It is **not** the pilot implementation.

> **Status: DRAFT — pending Olu sign-off (§8).** Nothing in this charter ships
> until the approvals table is complete. Sections are numbered so downstream
> tickets can cite a stable anchor (e.g. "§5.3"). Owning ticket: **QVAC-22673**.
> Delivered in `docs/devops/` per the ticket; it is the agentic sibling of the
> deterministic gates catalogued in [`TIER-1-SCOPE.md`](./TIER-1-SCOPE.md).

## §1 — Current state (grounded)

What exists in the repo today, so the pilot is scoped against reality rather than
against an idealized blank slate:

- **A mature *local* agent framework** — canonical source at
  [`packages/ocr-ggml/.agent/`](../../packages/ocr-ggml/.agent/): implementer,
  test-writer, ci-validator, and code/security/correctness/performance/consistency
  reviewer agents; `orchestrate` / `review` / `ci-validate` / `release` skills; and
  a behavioural [`conduct.md`](../../packages/ocr-ggml/.agent/conduct.md). It is
  copied into `.claude/` and `.cursor/` by `/setup`. It runs **interactively on a
  developer's machine**, never in CI.
  *(The QVAC-22673 description points at `packages/ocr-onnx/.agent/`; that package
  was retired — the live path is `packages/ocr-ggml/.agent/`.)*
- **Human-gated, read-only PR-review skills** —
  [`.cursor/skills/qv-pr-review`](../../.cursor/skills/qv-pr-review/SKILL.md) and
  [`.cursor/skills/qv-devops-pr-review`](../../.cursor/skills/qv-devops-pr-review/SKILL.md).
  They post a single **PENDING** GitHub review that a human submits — they never
  self-submit APPROVE / REQUEST_CHANGES. Both are `disable-model-invocation: true`.
- **Guardrail rules** that assume an interactive human confirming every mutation —
  [`.cursor/rules/devops/agentic-automation.mdc`](../../.cursor/rules/devops/agentic-automation.mdc)
  ("AI-first, human-gated"; read-only default; plan-then-apply; **no trusted
  auto-apply**) and the repo-wide
  [`.cursor/rules/no-remote-code-execution.mdc`](../../.cursor/rules/no-remote-code-execution.mdc)
  (hard stop, no confirmation unlocks it).
- **Exactly one agentic-in-CI precedent, shipped disabled** — the
  `workflow-security-agent` job in
  [`.github/workflows/workflow-security.yml`](../../.github/workflows/workflow-security.yml)
  (the §B4 gate in [`TIER-1-SCOPE.md`](./TIER-1-SCOPE.md)). It runs
  `anthropics/claude-code-action` over just the changed workflow/action files, is
  warn-only, and is gated behind the `WORKFLOW_SECURITY_AGENT_ENABLED` repo
  variable (unset → skipped everywhere). It is a *single-surface* proof of the
  rails; this charter generalizes those same rails to a broader PR capability.
- **Upstream-compat smokes, not PR agents** —
  [`openclaw-upstream-compat.yml`](../../.github/workflows/openclaw-upstream-compat.yml)
  and `opencode-upstream-compat.yml` exercise QVAC's own plugins against upstream
  OpenClaw / OpenCode. The OpenClaw PR run **skips the agent turn**
  (`SKIP_OPENCLAW_AGENT`); OpenCode has no `pull_request` trigger at all. Neither
  reviews PRs.

**Gap the pilot fills:** the existing rails presume a human confirms each mutation
interactively. A CI agent has no interactive human at execution time, so it needs
*non-interactive* rails. §5 defines them and reconciles them with the no-trusted-
auto-apply stance.

## §2 — Goal & non-goals

### §2.1 Goal

Prove, on one repo and one surface, that an agent running **inside GitHub Actions**
can produce **advisory, non-blocking** PR feedback (a PR summary and/or advisory
review comments) that reviewers find useful — under guardrails strong enough that
the worst-case failure is a noisy comment, never a bad merge, a leaked secret, or
an unattended state change. Produce enough signal (§7) to make a keep / iterate /
kill decision.

### §2.2 Non-goals (explicitly out of scope for the pilot)

- **No merge authority.** The agent never approves, requests changes, merges,
  closes, labels-for-merge, or otherwise gates a PR. It is never a required check.
- **No code mutation.** It does not push commits, open fix-up PRs, edit files in
  the repo, or apply suggestions. Its only write is one advisory PR comment.
- **No infra / release actions.** No deploys, tags, releases, branch-protection or
  ruleset edits, secret rotation, or cloud IAM changes.
- **No multi-repo rollout.** One repo only (§3). Fleet-wide enablement is a
  separate, post-pilot decision.
- **Not a replacement** for `qv-pr-review` / `qv-devops-pr-review` or human review.
  It augments; humans still own the verdict.
- **Not the implementation.** This charter authorizes and bounds; the workflow is
  built under the follow-up tickets in §9.

## §3 — Scope: target repo & surface

- **Repo (one):** [`tetherto/qvac`](https://github.com/tetherto/qvac) — the QVAC
  monorepo. It is already the Tier-1 pilot repo for the deterministic enforcement
  gates ([`TIER-1-SCOPE.md`](./TIER-1-SCOPE.md) §A), so the agentic pilot rides the
  same review-audience, CI conventions, and guardrail rules rather than opening a
  second frontier.
- **Surface (one):** same-repo pull requests. **Fork PRs are out of scope** for the
  pilot (they receive no secrets — see §5.4).
- **Optional narrower start:** gate the pilot behind an opt-in PR label (e.g.
  `agent-review`) for the first weeks to bound cost and blast radius, then widen to
  all same-repo PRs once signal and cost are understood. Decision recorded in §7.

## §4 — Pilot design (capability · runtime · trigger · location)

| Dimension | Decision | Rationale |
|---|---|---|
| **Capability** | **Advisory PR summary + optional non-blocking review comment**, emitted as a **single upserted PR comment** with a provenance marker. Warn-only. | Purely additive; a wrong summary is low-harm. Mirrors the `workflow-security-agent` output contract and the "PENDING-only" spirit of `qv-pr-review`. |
| **Runtime** | **Claude Code via `anthropics/claude-code-action`** (already SHA-pinned and wired in `workflow-security.yml`). | Smallest new attack surface: reuses the existing pinned action, the `ANTHROPIC_API_KEY` secret, and the enablement-variable pattern. Alternatives deferred (§4.1). |
| **Trigger** | `pull_request` on same-repo PRs, optionally filtered to the `agent-review` label; scoped to the PR diff. | Bounds cost and keeps feedback targeted, exactly as the precedent scopes to changed files. |
| **Where it runs** | GitHub Actions, GitHub-hosted `ubuntu-latest`, in its own job modelled on `workflow-security-agent`. | Reuses the vetted job shape (harden-runner, least-privilege perms, bounded tools, `continue-on-error`, `timeout-minutes`). |
| **Output verdict** | Never a GitHub *review* verdict. No APPROVE / REQUEST_CHANGES; comment only. | Keeps the human as the sole approver (§5.1). |

### §4.1 Runtime alternatives (considered, deferred)

- **Cursor SDK / Cursor CLI agent** — viable, but not currently wired into this
  repo's CI; adopting it means a new secret, new pinning, new egress to
  characterize. Reconsider if the pilot outgrows Claude Code.
- **opencode / openclaw** — QVAC ships plugins for both, but their CI presence is
  upstream-compat smoke only (§1); neither runs a PR-review turn today. Deferred.

The runtime choice is deliberately reversible — the guardrails in §5 are
runtime-agnostic, so a later swap does not reopen the charter.

## §5 — Guardrails

The pilot inherits every rail in
[`agentic-automation.mdc`](../../.cursor/rules/devops/agentic-automation.mdc),
[`github-actions.mdc`](../../.cursor/rules/devops/github-actions.mdc), and
[`secrets-and-credentials.mdc`](../../.cursor/rules/devops/secrets-and-credentials.mdc),
plus the CI-specific rails below.

### §5.1 Read-only by default; no auto-approve / no auto-merge

The agent is **advisory-output-only**. It performs **zero** state-changing
operations: no merge, approve, label, push, file write to the repo tree, or
protected-branch change. Its single side effect is upserting one PR comment
(reversible, non-authoritative). All actual state changes — approve, merge, apply —
remain 100% human.

### §5.2 Reconciliation with the no-trusted-auto-apply stance

`agentic-automation.mdc` requires "plan-then-apply" with a human confirming each
mutation and states **there is no trusted auto-apply mode**. That rule was written
for *interactive* skills. This pilot honours the same principle by a different
mechanism suited to non-interactive CI:

- **There is no `apply` to gate.** The agent produces only advisory text; it never
  reaches a state-changing step, so "no trusted auto-apply" holds trivially — the
  agent has nothing to auto-apply.
- **The human gate is relocated, not removed.** Instead of a human confirming each
  action mid-run, the human boundary is structural: (a) the agent's capability set
  is read + comment only, enforced by GitHub token permissions (§5.3) and the
  agent tool allow-list (§5.6); (b) every merge/approve stays human.
- **Provenance replaces the interactive prompt** (§5.5): because no human watches
  the run live, every agent output is labelled so reviewers know to weight it as
  machine-generated and unverified.

This reconciliation is the load-bearing decision of the charter; if a reviewer
disagrees with it, the pilot does not proceed. A one-line pointer to this section
should be added to `agentic-automation.mdc` when the pilot is approved, so the
rule and the charter stay consistent (§9).

### §5.3 Minimal permissions

Least-privilege `GITHUB_TOKEN`, matching the precedent's agent job:

```yaml
permissions:
  contents: read
  pull-requests: write   # upsert exactly one advisory comment
```

No `contents: write`, no `id-token: write`, never `write-all`. Top-level workflow
defaults to `contents: read`; the comment scope is widened only on the agent job.

### §5.4 Fork-PR secret isolation

The agent needs `ANTHROPIC_API_KEY`, and `pull_request` from a fork gets a
read-only token and **no secrets** (enforced by GitHub; must not be circumvented).
The pilot therefore **skips fork PRs** and runs on same-repo PRs only — identical
to the `workflow-security-agent` gate:

```yaml
if: >-
  github.event_name != 'pull_request' ||
  github.event.pull_request.head.repo.full_name == github.repository
```

No conditional secret pass-through to forks. If fork coverage is ever wanted, it is
a separate, lead-reviewed design (a metadata-only `pull_request_target` follow-up
that does not check out PR HEAD), not a pilot tweak.

### §5.5 Provenance labeling

Every agent comment carries a stable HTML marker (for idempotent single-comment
upsert) and a visible footer identifying it as machine-generated, advisory, and
non-blocking — mirroring the precedent's `_Agentic audit … Warn-only …_` footer.
Reviewers must be able to tell agent output from human output at a glance.

### §5.6 No remote code execution

Enforced structurally, per
[`no-remote-code-execution.mdc`](../../.cursor/rules/no-remote-code-execution.mdc)
(hard stop):

- Agent tool allow-list is **`Read,Grep,Glob`** (read-only) plus at most a single
  `Write` to its own report file — **no `Bash`, no `Edit`** — so the agent cannot
  shell out, fetch-and-run, or mutate the tree.
- `step-security/harden-runner` is the first step (egress `audit` → `block` once
  the api.anthropic.com + toolchain egress is characterized).
- The action and its toolchain are installed pinned (SHA-pinned action; package
  manager for deps), never via a piped remote installer.

### §5.7 Human override & kill-switch

- **Off by default.** The job is gated behind an enablement repo variable (e.g.
  `AGENTIC_PR_PILOT_ENABLED`), unset → skipped everywhere — the
  `WORKFLOW_SECURITY_AGENT_ENABLED` pattern. Enabling/disabling is a variable flip,
  **no workflow edit or revert required**.
- **Never blocks.** `continue-on-error: true` on the agent step and a warn-only
  outcome: a model/quota/tool hiccup degrades to a warning, never a failed check.
- **Instant kill.** Unset the variable → the pilot stops on the next run. Detailed
  triggers for pulling the switch are in §7.3.

### §5.8 Bounded resource use

`--max-turns` cap, diff-scoped context, same-repo-only, optional label gating, and
`timeout-minutes` (≈20, per the precedent) bound each run. Concurrency
`cancel-in-progress: true` since the only external effect is an idempotent comment
upsert (newest-commit-wins is correct here).

## §6 — Data handling, security & cost

### §6.1 What leaves the repo

- **To the model (`api.anthropic.com`):** the PR diff and the files the agent
  `Read`s within the changed scope, plus the prompt. `tetherto/qvac` is a **public**
  repo, so this content is already public — exposure risk is low. Context is scoped
  to the PR, not the whole tree.
- **Never to the model:** repository secrets. Fork PRs (which never receive
  secrets) are skipped; `ANTHROPIC_API_KEY` is passed to the action's `with:`
  input, never echoed, never placed in the prompt. Standard secrets rules
  ([`secrets-and-credentials.mdc`](../../.cursor/rules/devops/secrets-and-credentials.mdc))
  apply.
- **Provider data terms** (retention, no-training-on-API-inputs) must be confirmed
  against the actual Anthropic commercial API agreement before enablement — a
  named security stakeholder deliverable (§8), not an assumption baked in here.

### §6.2 Cost budget

Cost is bounded structurally rather than by a hard dollar cap in YAML: `--max-turns`
× diff-scoped context × (optional) label gate × same-repo PR volume. Method:
estimate `same-repo PRs/month × avg tokens/PR × model rate` during design (§9) and
record a **monthly ceiling** plus a **per-PR ceiling** in the pilot ticket. A cost
overrun beyond the ceiling is an explicit kill trigger (§7.3). No unbounded loops:
the turn cap and timeout are the backstops.

## §7 — Success metrics, evaluation window, kill-switch & exit

### §7.1 Evaluation window

A fixed window of **~4–6 weeks or ~50 same-repo PRs, whichever comes first.** No
open-ended "temporary" pilot: the window ends in a recorded decision (§7.4).

### §7.2 Metrics

| Metric | How measured | Target (tune at kickoff) |
|---|---|---|
| **Signal quality** | Reviewer 👍/👎 reaction on the agent comment (lightweight, in-PR) | ≥ 60% 👍 among reacted PRs |
| **False-positive rate** | Fraction of agent-flagged items reviewers judge wrong/noise | ≤ 20% |
| **Reviewer time saved** | Self-report + PR cycle-time (time-to-first-human-review) as a proxy | Net positive / neutral |
| **Cost per PR** | Tokens × rate, from run logs | Within the §6.2 ceiling |
| **Added latency** | Agent job duration | Does not delay human review (runs in parallel) |

### §7.3 Kill-switch triggers (any one → unset the enablement variable)

- False-positive rate persistently above target, or reviewers muting/ignoring the
  comment.
- A guardrail breach: any attempt at a state change beyond the single advisory
  comment, any secret exposure, any RCE-pattern attempt.
- Cost exceeds the §6.2 ceiling.
- A security-stakeholder objection to the provider data terms (§6.1).

Because the switch is a repo-variable flip (§5.7), killing the pilot is immediate
and needs no revert PR.

### §7.4 Exit criteria (end of window → one recorded decision)

1. **Promote** — sustained useful signal within cost/FP targets → plan a scoped,
   still-non-blocking widening (more PRs, then possibly fork-safe coverage), each
   its own charter/ticket.
2. **Iterate** — promising but noisy → one more bounded window with a tuned prompt
   / scope, then re-decide.
3. **Retire** — signal not worth the cost/complexity → unset the variable, delete
   the workflow, record the learning.

Promotion toward any *blocking* behaviour is explicitly **not** on the table within
this charter and would require a fresh decision — matching the §B1–§B4 "shadow mode
→ blocking needs TL sign-off" sequencing in [`TIER-1-SCOPE.md`](./TIER-1-SCOPE.md).

## §8 — Approvals & stakeholders

The pilot does not ship until this table is complete.

| Role | Who | Responsibility | Status |
|---|---|---|---|
| **Charter approver** | **Olu** | Sign-off on the pilot, its scope, and the §5.2 reconciliation | ☐ Pending |
| **PR checks / merge integration** | **Sidd** | Confirm the pilot never becomes a required check and does not perturb `qvac-merge-guard / validate-pr` | ☐ Pending |
| **Security** | *(security stakeholder — assign)* | Confirm data handling (§6.1), Anthropic data terms, fork-PR isolation, egress hardening | ☐ Pending |
| **DevOps owner** | *(DevOps pod — `.github/teams/devops.json` lead)* | Own the workflow, enablement variable, secret, and rollout mechanics | ☐ Pending |

Acceptance criteria from QVAC-22673, tracked here: charter approved by Olu (row 1);
scope limited to one repo with explicit success/exit criteria (§3, §7); CI-specific
guardrails reconciled with `agentic-automation.mdc` (§5.2); follow-up implementation
tickets created (§9).

## §9 — Follow-up implementation tickets (from this charter)

Proposed on approval — the charter is the decision; these are the build. IDs
assigned when filed in Asana under QVAC-22673.

1. **Implement the pilot workflow** — a warn-only `pull_request` agent job (own file
   or extending the `workflow-security-agent` pattern): same-repo-only gate,
   least-privilege perms (§5.3), harden-runner, `Read,Grep,Glob,Write` tool
   allow-list, diff-scoped prompt, single upserted provenance-labelled comment,
   `continue-on-error`, `timeout-minutes`. `actionlint` clean.
2. **Enablement, secret & budget wiring** — add the `AGENTIC_PR_PILOT_ENABLED` repo
   variable (default unset), the `ANTHROPIC_API_KEY` secret (if not already
   present), the per-PR / monthly cost ceilings (§6.2), and a `workflow_dispatch`
   manual-trial hook.
3. **Reviewer feedback & metrics** — the 👍/👎 mechanism and a lightweight metrics
   collection/summary for the §7.2 table over the evaluation window.
4. **Security review of provider data terms** — confirm Anthropic API
   retention / no-training posture and egress allow-list; flip harden-runner to
   `block` once characterized (§6.1, §5.6).
5. **Rule reconciliation** — add a pointer from
   `agentic-automation.mdc` to §5.2 so the always-on rule references the CI
   non-interactive rails.
6. **End-of-window decision review** — evaluate metrics against §7 and record the
   promote / iterate / retire outcome.

---

*This is a decision/charter artifact only — not the pilot implementation. It lives
in `docs/devops/` per QVAC-22673 and is the agentic companion to
[`TIER-1-SCOPE.md`](./TIER-1-SCOPE.md).*
