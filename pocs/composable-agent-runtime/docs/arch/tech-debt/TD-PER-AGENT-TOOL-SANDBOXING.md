# TD: Per-Agent Tool Sandboxing

## Summary

Harness has skill grants, approvals, command validation, cancellation, and
bounded output, but side-effecting tools do not yet execute inside isolated
per-agent runtime units.

## Severity

High

## Category

Architecture / Security / Reliability

## Description of the Problem

The current Workbench Harness bundles and hash-validates curated skill
packages, loads their manifests and resource files, and derives scoped grants
for tools, binaries, CLI operations, URL prefixes, and credentials. These
controls limit which operation the model may request, but they do not provide
per-agent runtime isolation.

Current execution has two important limitations:

1. Shell commands are spawned from Harness as child processes. Timeout and
   cancellation terminate the process tree, but commands still run with the
   host user's filesystem, network, and process permissions.
2. Python runs through a shared in-process Pyodide interpreter. Runs are
   serialized, but Python can reach the Harness JavaScript realm through
   `js.globalThis`. A CPU-bound script can block the Harness thread, and the
   current timeout or abort path cannot interrupt it while it is executing.

Consequently, one agent's tool execution can consume or corrupt shared Harness
runtime state, block unrelated agents, retain state longer than intended, or
reach resources beyond the handles deliberately assigned by the broker.
Bundled-skill integrity and command validation reduce authority but do not
contain runtime failure.

Mobile platforms also provide different guarantees. A Worklet can separate
runtime state and lifecycle while sharing the host process. An Android Service
can contain a crash but normally shares the app UID and permissions. Neither
mechanism automatically provides an OS security sandbox.

## Recommended Solution

1. Introduce a platform-neutral `ToolSandbox` contract owned by Harness with
   start, execute, cancel, inspect, reset, and close operations.
2. Create one lightweight sandbox unit per active agent and reuse it across
   that agent's sequential tool calls. Tear it down after an idle timeout or
   when the agent runtime is garbage-collected.
3. Keep tool policy, approval, and capability decisions in the Harness broker.
   Pass only the selected skill resources, scoped tool operations, filesystem
   roots, network destinations, and credential handles into the sandbox.
4. Move Python execution out of the Harness JavaScript realm. Run each agent's
   Pyodide interpreter inside its sandbox and support hard termination when an
   interrupt cannot stop execution safely.
5. Route shell and other side-effecting tools through the same sandbox
   contract. Preserve process-tree termination, timeout, output bounds, and
   command validation as defenses inside that boundary.
6. Use platform-specific adapters:
   - desktop process adapter for state and crash containment;
   - Android Worklet or Service adapter according to the required failure
     boundary;
   - iOS Worklet adapter for lifecycle and state separation, without claiming
     process crash containment.
7. Associate each sandbox generation with stable agent and run identifiers.
   Reject late results after cancellation, sandbox replacement, or Harness
   recovery.
8. Add shared conformance tests for grant enforcement, agent-state separation,
   cancellation, timeout, idle teardown, crash recovery, and late-result
   fencing across every platform adapter.

## Migration Path

1. Define the sandbox contract and run existing tool adapters through an
   in-process compatibility adapter.
2. Move Pyodide first because it can block and access the Harness realm.
3. Move shell execution and bundled skill resources into the sandbox.
4. Add per-agent lifecycle management and idle teardown.
5. Enable stronger platform adapters after they pass the shared conformance
   suite.

## Acceptance Criteria

- One agent's Python execution cannot access another agent's interpreter state
  or the Harness JavaScript realm.
- A non-terminating Python or shell operation can be stopped without
  restarting Harness or interrupting another agent.
- Each sandbox receives only the brokered tools, skill resources, filesystem
  roots, network destinations, and credential handles for its agent.
- Sandbox restart or replacement does not permit an older generation to commit
  a late result.
- Idle teardown releases processes, interpreters, temporary files, and
  credential handles.
- Desktop and mobile adapters pass the same behavioral conformance suite, with
  platform-specific crash-containment guarantees documented explicitly.

## Risk if Not Addressed

- A CPU-bound Python call can freeze all agent execution hosted by Harness.
- Tool state or credentials may leak between agents through shared runtime
  memory.
- A failed tool process can destabilize Harness and interrupt unrelated runs.
- Mobile implementations may be described as sandboxed despite providing only
  logical runtime separation.

## Risks of the Solution

- Per-agent runtimes increase startup latency and memory use.
- Hard termination loses non-durable interpreter and tool state.
- Platform adapters may provide different crash-containment guarantees,
  requiring careful capability reporting and tests.

## Out of Scope

- Running arbitrary untrusted third-party agent code.
- Guaranteeing identical OS process isolation on every mobile platform.
- Container orchestration or remote hosted execution.
- Durable replay of external side effects, tracked separately in
  [Durable agent effect recovery](TD-DURABLE-AGENT-EFFECT-RECOVERY.md).
