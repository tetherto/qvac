# Plan: local development agent PoC ("opencode-class")

Target: a solid proof of concept — not a production product — of a local-first
coding agent on the Composable Agent Runtime, where:

- agents can be **created and steered from a phone and from desktop**;
- **code execution and file access run on desktop**, sandboxed;
- real **development work** is possible through skills (read/edit/search/run);
- the **agentic loop** is durable and observable from either device;
- inference uses `@qvac/sdk` **as it is today** (local Qwen, no hosted providers).

This document states what exists, what is missing, and the implementation order.
It follows the direction in `docs/arch/qip/agentic-sdk-p2p-layering.md` and does
not propose anything that contradicts it.

> **Revised against `f482f07f` (boundary refactor).** That commit closed most of
> G2 and roughly half of G3, and left G1, G4, and G5 untouched. It also
> introduced one new obstacle — tool injection is no longer reachable from an
> application — which now sits on the critical path for G1. Status is marked per
> gap below; section 4 workstreams are updated accordingly.

---

## 1. What already exists and is reusable

These are load-bearing and should not be rebuilt.

| Capability | Where | State |
| --- | --- | --- |
| Agentic tool loop | `packages/harness/lib/brokered-model-adapter.ts` | Works; fixed 10-round cap (`MAX_TOOL_ROUNDS`) |
| Agent registration (instructions, skills, tool policy) | `packages/harness/lib/agent-registration.ts` | Works; `LocalHarnessRuntime` only |
| Skill format (`SKILL.md` frontmatter + grants) | `packages/harness/lib/skills/`, `packages/harness/skills/` | Works; same shape as Claude/opencode skills |
| Scoped tool grants (`exec(obsidian)`, `http_request` + allow-list) | `lib/skills/tool-grants.ts`, `lib/tool-broker.ts` | Works |
| Per-agent macOS Seatbelt sandbox, lazy start, idle close, fenced generations, cancellation, bounded output | `lib/tool-sandbox/` | Works, **macOS only**, 2 tools |
| Approval port | `HarnessToolApprovalPort` in `lib/tool-broker.ts` | Exists; internal to harness composition |
| Durable work profile: envelope, journal, cancellation, checkpoint-ref, **gates**, outcome, executor presence | `packages/sync/lib/profiles/durable-work/contract.ts` | Schema complete; semantics unspecified |
| Transportable run state + checkpoints + available-work watch | `packages/agents/lib/agent-state-store.ts` | Interface exists, Sync + in-memory impls |
| Supervised 3-runtime topology, restart, suspend/resume | `packages/harness`, `packages/sync`, `@qvac/supervisor` | Validated desktop + Android |
| Assistant facade: `run`/`readRun`/`state.mesh`/`openProfile`/lifecycle | `packages/assistant/lib/facade.ts` | Works |
| One-plugin Expo packaging for mobile | `packages/assistant/expo-plugin.ts` | Validated on physical Android |
| Phone-writes / desktop-executes slice | `apps/task-cli`, `apps/task-mobile` | Validated end-to-end with Qwen |
| Model-driven skill runs with real sandbox | `apps/skill-cli` | Validated on macOS |

The two demo apps already prove the hard parts of the topology. `skill-cli`
proves the loop and the sandbox. Neither proves *coding*.

---

## 2. The gap, stated plainly

Five things stand between this and an opencode-class PoC.

### G1 — There are no coding tools — **OPEN, and now harder**

`desktop-executor.ts:22` registers exactly two tools: `http_request` and `exec`,
and `exec` is gated by a **per-CLI JSON schema validator** (`skills/obsidian/cli.schema.json`).
That design intentionally does not generalise to a shell.

Missing: `read`, `write`, `edit`/patch, `ls`, `glob`, `grep`, `bash`.
Missing: any notion of a **workspace root**, path containment, or git awareness.
Missing: snapshot/undo for agent-authored edits.

This is the single largest piece of net-new work and it is the whole point of
the PoC.

**New since `f482f07f`:** there is no longer any application-reachable way to
inject a tool. `CreateHarnessOptions` accepts only
`inference | logging | state | desktop`, and `tools` / `toolBroker` moved to the
private `CreateHarnessServiceOptions`. The only extension surface is
`HarnessDesktopConfig` (`lib/runtime/desktop-config.ts:7`) — a closed shape with
named `obsidian` / `weather` / `image` blocks.

So adding coding tools now forces a choice:

- **(a)** Extend `HarnessDesktopConfig` with a `workspace` block. Fast, but puts
  workspace policy and git behavior inside `@qvac/harness`, which the QIP
  explicitly assigns to applications.
- **(b)** Re-open a narrow, typed tool-provider port on `CreateHarnessOptions`,
  so a product package supplies schemas + broker. More work, matches the QIP.

**Recommendation: (b).** The refactor tightened boundaries by closing them; the
correct fix is a deliberate port, not a hole punched back through the config.
This is the first decision to make — everything in P2 depends on it.

### G2 — The agent surface is not reachable from Assistant — **MOSTLY CLOSED**

`f482f07f` resolved the core of this. `AssistantFacade` now exposes
`registerAgent`, `run({agentId, input})`, `cancelRun`, and `readRun` returning a
durable `HarnessRunRecord` (`packages/assistant/lib/facade.ts:42`). The harness
wire contract gained `listSkills`, `watchWork`, and lifecycle controls
(`lib/runtime/create-harness.ts:42`). `state.work` is now a first-class
durable-work endpoint on the facade. A phone can create and steer an agent.

Two pieces remain open:

1. **Approvals regressed.** The approval port is now hardcoded in
   `lib/runtime/desktop-config.ts:52` — `approve()` returns the static
   `config.obsidianApproval` boolean. It went from internal-but-pluggable to
   internal-and-constant. Interactive approval is a hard requirement for `bash`
   and is the pivot of the P4 demo, so this needs a real application-facing port:
   a pending-approval event stream plus `resolveApproval(operationId, decision)`.
2. **Staged readiness is still one gate.** `ready()` is
   `supervisor.ready()`. `TD-STAGED-ASSISTANT-READINESS.md` and the QIP both want
   state-ready / execution-ready / per-model-ready separated.

`apps/skill-cli` still depends on `@qvac/harness` directly, but that is now
defensible — it supplies `HarnessDesktopConfig`, which Assistant does not
forward. Resolving G1 via option (b) should also settle whether skill-cli moves
onto Assistant.

### G3 — Durable delegation has a schema but no contract — **HALF CLOSED**

`f482f07f` built the durable substrate. `@qvac/harness` now owns
`HarnessRunStore` with in-memory and Sync-backed implementations
(`lib/run-store.ts`, `lib/sync-harness-run-store.ts`), storing sequenced run
events, checkpoints, and outcomes, plus `watchWork` for discovery. Notably
`HarnessRunOutcome` already includes `interrupted` and `indeterminate`
(`lib/run-store.ts:22`) — exactly the at-most-once posture this plan assumes.
`TD-STRUCTURAL-COMPOSITION-PORTS.md` is addressed by `lib/state-port.ts`.

What remains is the part that was always the hard half:

`durable-work` carries everything needed (`advertise-executor`, `open-gate`,
`resolve-gate`, `save-checkpoint-ref`, `request-cancel`), but per the QIP
(gate **G1**, and `TD-DURABLE-AGENT-EFFECT-RECOVERY.md`) there is **no claim
state machine**: no lease, no fencing token, no stale reclaim. Two desktops can
claim the same run. Side-effecting tools — which is all coding tools — must not
run under "duplicate-possible".

Run events are now durably stored and readable via `readRun`, but there is still
no `watchRun(runId)` giving live-overlay-plus-durable-truth, so the phone can
poll a desktop run but not stream it.

### G4 — There is no session or context management — **UNCHANGED**

`assistant.run()` takes a `messages` array per call. There is no session
concept, no persistence of conversation, no compaction, no context budget, and
no token accounting surfaced to the app. The loop stops at 10 rounds and emits a
fallback string (`brokered-model-adapter.ts:126`).

Real coding work exceeds 10 rounds and exceeds a 4B model's context.

`f482f07f` did not touch this. `MAX_TOOL_ROUNDS = 10` is still hardcoded in
`lib/brokered-model-adapter.ts:8` — it merely stopped being publicly exported.
Note that `@qvac/agents` became a per-run **workflow-operation** engine with
checkpoints (`packages/agents/lib/agent.ts`), not a tool loop; the tool loop
stayed in Harness. That is consistent with the QIP, but it means the compaction
and turn-budget interfaces the QIP assigns to Agents do not exist yet on either
side.

### G5 — Sandboxing is macOS-only and read-shaped — **UNCHANGED**

`lib/tool-sandbox/` is Seatbelt-specific (`macos-launcher.ts`, `profile.ts`).
The current profiles mount narrowly and read-only (see `apps/skill-cli/README.md`).
There is no Linux (bubblewrap/landlock) or Windows path, and no
workspace-writable + network-denied profile.

`TD-PER-AGENT-TOOL-SANDBOXING.md` already classifies this as **High**. After
`f482f07f` the sandbox is also no longer publicly exported — better
encapsulation, but it means the workspace profile work (W3) must land inside
Harness rather than in a product package.

---

## 3. Scope decisions for the PoC

Stated up front so the plan stays finishable.

**In scope**
- macOS desktop executor + Android phone client. (Both already validated.)
- One workspace root per desktop executor, bound at startup.
- At-most-once execution with explicit manual resume on interruption.
- Approval-gated `bash`; auto-allowed read-only tools.
- Local Qwen through `@qvac/sdk` as it is now.

**Explicitly out of scope**
- iOS inference containment (QIP S9 / `TD-IOS-SDK-CRASH-ISOLATION.md`).
- Exactly-once effects, at-least-once with idempotency (QIP G1 production gate).
- Linux/Windows sandbox backends.
- LSP, multi-agent handoff, hosted providers, multi-user meshes.
- P9 numeric budgets (QIP S2) — measure, don't gate.

**Assumption flagged:** Qwen3.5-4B tool-call reliability is a real risk for
coding work — the repo already carries a BFCL tool-call failure reproducer
(commit `8483670a`). The PoC should be able to swap in a larger local model
without code change; if 4B cannot drive a 7-tool loop, that is a finding, not a
blocker on the architecture.

---

## 4. Workstreams

### W1 — Agent surface on Assistant — *largely delivered by `f482f07f`*

Delivered: `registerAgent` / `run` / `cancelRun` / `readRun` on the facade,
promoted to the harness wire contract, plus `listSkills` and `watchWork`.

Remaining:

1. **Tool-provider port** (was implicit, now explicit — see G1 option (b)). A
   typed way for a product package to supply tool schemas + a broker through
   `CreateHarnessOptions`. **Blocks all of W2.**
2. **Approval port.** Replace the static `obsidianApproval` boolean with a
   pending-approval stream plus `resolveApproval(operationId, decision)`,
   surfaced on `AssistantFacade`. Keep `memoizeToolApproval` for
   session-scoped "always allow".
3. **Staged readiness** (`TD-STAGED-ASSISTANT-READINESS.md`): split `ready()`
   into state / execution / per-model gates.
4. **`watchRun(runId)`** — live overlay over the durable record, so a phone
   streams rather than polls.

**Done when:** a product package can register coding tools and answer approvals
through `@qvac/assistant` alone.

### W2 — Workspace and coding toolset *(the bulk of the work)*

1. **Workspace port.** A `Workspace` concept owned by the application layer, not
   Harness: root path, path-containment enforcement, ignore rules, and git
   status/branch read. Per the QIP, "product-specific coding tools, workspace
   policy, git behavior" stay in an application package — so this lives in a new
   `apps/code-cli` (or `packages/coding-tools` as a product package), **not** in
   `@qvac/harness`.
2. **Tools**, each with a `HarnessToolSchema` and a grant scope:
   - `read(path, offset?, limit?)` — bounded output
   - `write(path, content)` — approval required
   - `edit(path, oldString, newString)` — approval required, exact-match semantics
   - `ls(path)`, `glob(pattern)`, `grep(pattern, path?)` — ripgrep-backed
   - `bash(command, timeout?)` — approval required, workspace cwd
3. **Grant scoping.** Extend `parseToolGrant` usage so a skill can declare
   `read(workspace)`, `bash(workspace)` etc. The existing `name(scope)` syntax
   already supports this; the executor needs to enforce workspace scope rather
   than per-CLI argv schemas.
4. **Snapshot/undo.** Before the first mutating tool call in a run, snapshot the
   workspace (git stash-like or copy-on-write); expose revert. Without this,
   nobody will let a 4B model edit their repo.
5. **Coding skill.** A `SKILL.md` that teaches the loop: explore before editing,
   prefer `edit` over `write`, run tests after changes.

### W3 — Sandbox profile for development work

1. New Seatbelt profile: workspace read-write, everything else read-only,
   network **default-deny** (the weather proxy stays the only egress path, and
   only for skills that grant it).
2. Allow the toolchain the workspace needs (node/bun/git/rg) via explicit
   executable allow-listing, reusing the Mach-O validation already in
   `desktop-executor.ts`.
3. Keep the existing lazy-start / idle-close / fenced-generation lifecycle
   (`lib/tool-sandbox/registry.ts`) — it is already correct for this.
4. Non-macOS hosts: fail closed with a clear error. Do not silently run unsandboxed.

Addresses `TD-PER-AGENT-TOOL-SANDBOXING.md`.

### W4 — Durable run: phone creates, desktop executes

1. **Claim state machine** over `durable-work`: `acquire → lease → renew →
   fence → expire/reclaim → terminal`. Minimum viable = single-holder lease with
   a monotonic fencing token; a claim whose lease expired cannot commit.
   Documented as **at-most-once**; an interrupted run is marked
   `interrupted/recoverable` and requires explicit user resume. This satisfies
   the PoC without pre-empting QIP gate G1.
2. **Event transport.** Encode `HarnessEvent` into `append-journal` entries
   (typed, redacted per the existing skill-cli allow-list discipline) and
   implement `watchRun(runId)` on the facade: live overlay where connected,
   durable journal as source of truth.
3. **Approval over mesh.** Wire `HarnessToolApprovalPort` to
   `open-gate`/`resolve-gate` so a desktop `bash` call raises a gate the phone
   can approve or reject. **This is the demo that justifies the whole
   architecture** — prioritise it.
4. **Capability matching.** Desktop advertises `advertise-executor` with
   capabilities including its workspace identity; the phone targets a run at a
   workspace, not at a device.

Related debt: `TD-AGENT-RUNTIME-TASK-RECOVERY.md`,
`TD-AGENT-RUNTIME-FAILURE-ESCALATION.md`, `TD-AGENT-RUNTIME-TIMEOUT-POLICY.md`
(long tool calls must not trip the lease).

### W5 — Sessions and context

1. **Session** = ordered set of runs plus conversation state, persisted through
   the existing `AgentStateStore` (`packages/agents/lib/agent-state-store.ts`)
   so it replicates for free.
2. Replace the fixed `MAX_TOOL_ROUNDS` with a **turn budget** (rounds, wall
   clock, and token ceiling) surfaced as configuration and reported on the
   `metrics` event.
3. **Compaction:** when context nears the model window, summarise older turns
   and checkpoint. The QIP assigns compaction *interfaces* to `@qvac/agents` and
   *coordination* to Harness — respect that split.
4. Surface token/context usage on the existing `metrics` event so the phone can
   show it.

### W6 — Two clients

1. **`apps/code-cli`** — desktop TUI/CLI: pick workspace, start session, stream
   events, answer approvals inline. This is the primary development surface.
2. **`apps/task-mobile` extension** (or a sibling app) — pick a paired
   workspace, start a session, stream events, approve/reject gates, cancel.
   Reuses the existing pairing and one-plugin Expo packaging.

---

## 5. Order of execution

Each phase ends in something demonstrable.

| Phase | Content | Demo |
| --- | --- | --- |
| **P1** | W1 (agent surface on Assistant) + W5.1 (sessions) | `skill-cli` runs unchanged through Assistant; a session survives restart |
| **P2** | W2 (workspace + tools) + W3 (dev sandbox) | Desktop CLI: "add a test for X and run it" completes locally, sandboxed, with approvals |
| **P3** | W4.1–W4.2 (claim + event journal) | Phone starts a run on a desktop workspace and watches it stream |
| **P4** | W4.3 (approval gates over mesh) + W6.2 (mobile client) | **Phone approves a desktop `bash` call mid-run** |
| **P5** | W5.2–W5.4 (budgets + compaction) + W2.4 (snapshot/undo) | A multi-hour session that compacts, and a revertible bad edit |

P1 and P2 are sequential. P3 can start in parallel with P2 once W1 lands.

---

## 6. Decisions needed before P1

*(Updated after `f482f07f`. Decision 2 is resolved; 1 sharpened; 3 and 4 stand.)*

1. **Tool extension model — the blocking decision.** Extend the closed
   `HarnessDesktopConfig` with a `workspace` block, or add a typed tool-provider
   port to `CreateHarnessOptions` so a product package supplies coding tools?
   Recommendation: the port. The config route puts workspace and git policy
   inside `@qvac/harness`, which the QIP assigns to applications — and the
   refactor that just landed was specifically about honouring those boundaries.
2. ~~Does the harness refactor cover the agent surface?~~ **Yes — delivered.**
3. **Approval granularity.** Per-call, per-tool-per-session, or per-tool-forever?
   Recommendation: per-call by default with a session-scoped "always allow this
   tool" — `memoizeToolApproval` already exists for this. Now more urgent, since
   the approval hook regressed to a static boolean.
4. **`@qvac/agents` scope for the PoC.** It is now a workflow-operation engine
   with checkpoints. Do the turn-budget and compaction interfaces (QIP phase 3)
   move there now, or stay in Harness alongside the tool loop until after the
   PoC?

---

## 7. What this PoC will *not* prove

Recorded so the results are not over-claimed:

- No exactly-once or at-least-once guarantee for tool side effects.
- No iOS execution containment.
- No sandbox on Linux/Windows.
- No P9 resource budgets — measured, not enforced.
- No multi-user or role-scoped visibility (QIP gate G0 / spike S4).
- Tool-call reliability of a 4B local model is a measured outcome, not a claim.
