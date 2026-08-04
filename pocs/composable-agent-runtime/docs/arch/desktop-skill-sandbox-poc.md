# Desktop skill sandbox PoC validation

## Purpose

This PoC tested the orchestration and tool-isolation direction proposed by
[ADR 0002](./adrs/0002-multi-agent-orchestration-and-isolation.md). Weather,
read-only Obsidian, and Stable Diffusion represented network,
process/filesystem, and shared-model capabilities.

## Verdict

The central ADR hypothesis is feasible:

- Harness can own agent registration, run tracking, policy, approvals,
  model/tool rounds, and sandbox lifecycle while `@qvac/agents` remains a
  platform-independent per-run engine.
- Only side-effecting tools need per-agent execution isolation. The
  orchestration loop can remain shared when it has no raw external-resource
  access.
- Tool policy, approval, broker routing, and sandbox scope work as independent
  enforcement layers.
- One lazy, restartable sandbox per agent is practical and can be reused across
  sequential calls.
- A shared SDK runtime can serve multiple agents and both LLM and diffusion
  workloads without loading models inside each sandbox.

No architectural contradiction was found in the runtime and tool-isolation
parts of ADR 0002. This establishes feasibility, not production readiness or
completion of every acceptance criterion.

## Validated

1. **Harness orchestration:** Harness invokes `@qvac/agents` through a brokered
   model adapter and tracks runs by agent and run identity.
2. **Layered enforcement:** unknown, unselected, denied, malformed, or
   unapproved tool calls fail before executor access.
3. **Per-agent isolation:** agents receive distinct skill trees, scratch
   directories, sandbox generations, credentials, and capability sets.
4. **Lifecycle control:** lazy startup, reuse, idle teardown, cancellation,
   crash containment, bounded shutdown, and stale-result fencing work.
5. **Curated skills:** manifests and resources are bundled deterministically,
   hash-verified, and materialized only for selected skills.
6. **Network mediation:** Weather receives only an agent-fenced loopback
   capability while the host validates external destinations, redirects,
   addresses, TLS identity, and response bounds.
7. **Process and filesystem mediation:** Obsidian uses direct argv execution,
   exact executable and vault binding, read-only access, explicit approval,
   bounded output, and path-scoped desktop IPC.
8. **Shared model ownership:** LLM and diffusion plugins share one SDK runtime.
   Generation supports progress, busy rejection, cancellation after load,
   validated PNG output, atomic persistence, and partial-file cleanup.

## ADR acceptance-criteria coverage

1. Harness run registry and `@qvac/agents` dispatch: **validated**.
2. No raw Mesh, Sync, or credential access from agents: **partially
   validated**. Broker-only tool access was proven, but real Mesh and Sync
   capabilities were not integrated.
3. Independent policy, sandbox, and approval configuration: **validated**.
4. Recovery from replicated chunks and checkpoints: **not validated**.
5. Sandbox idle teardown independent of agent deletion: **validated**.
6. Bundled skills with per-agent brokered grants: **validated**.
7. Cancellation and late-result rejection: **partially validated**. Active
   work and stale results were covered; durable uncertain-effect recovery was
   not.

## Not validated

- Durable recovery after a Harness restart.
- Device ownership handoff through Mesh or Sync.
- Real Mesh, Sync, MCP, or Python/Pyodide capability mediation.
- Mobile Worklet isolation or non-macOS conformance.
- A production-supported macOS sandbox backend.
- Large concurrent-agent counts, sustained memory use, or production-load
  startup performance.
- Chunk retention, compaction, and bounded history reconstruction.
- Replay semantics for external effects whose cancellation cannot be
  confirmed.
- A separately isolated SDK/model RPC process in the desktop composition. The
  PoC used one shared in-process SDK broker.

## Production limitations

- `/usr/bin/sandbox-exec` is deprecated. It validates the macOS capability
  model but is not a production deployment mechanism.
- SDK 0.15 cannot cancel an in-progress `loadModel()`. It can only suppress
  generation and results after the load settles.
- The operating-system DNS resolver remains trusted. Address pinning and TLS
  hostname verification constrain the resulting connection.
- Desktop applications may require narrow trusted preflight and IPC
  capabilities. Obsidian required both without granting broad home or network
  access.

## Evidence

- 24 desktop runner tests with 127 expectations passed.
- 88 focused sandbox tests with 380 expectations passed.
- Real generic and desktop Seatbelt probes passed all 26 assertions.
- Real Qwen Weather crossed the sandbox and authenticated proxy to `wttr.in`.
- Real Qwen Obsidian read the approved vault through the official CLI.
- The gated diffusion path generated and validated a real PNG.
- Harness typechecking, Harness tests, deterministic packaging, clean-package
  installation, and the full PoC verification suite passed before the target
  branch advanced.

## Implication for ADR 0002

The Harness orchestration and per-agent tool-isolation direction has enough
evidence to be accepted.

ADR 0002 also includes durable state, Mesh mediation, device handoff, and
recovery claims that remain unvalidated. Those claims should either keep the
ADR proposed until demonstrated or move to a separate follow-up decision so
the validated runtime direction can be accepted independently.
