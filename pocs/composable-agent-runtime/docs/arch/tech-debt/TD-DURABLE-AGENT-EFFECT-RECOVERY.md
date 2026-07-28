# TD: Durable Agent Effect Recovery

## Summary

Agent checkpoints can resume completed model operations, but they do not yet
provide production-safe recovery around side-effecting tools.

## Severity

High

## Category

Architecture / Reliability

## Description of the Problem

`@qvac/agents` emits a checkpoint after each completed model operation and can
resume at the next operation. The current checkpoint contains operation
identifiers and outputs, but it does not record:

- a durable tool invocation before the effect starts;
- whether an external effect completed before Harness crashed;
- an effect receipt or provider idempotency key;
- whether an interrupted operation is safe to replay;
- rejection of a late result from an older runtime generation.

A crash after an external effect succeeds but before its result and checkpoint
are committed can therefore leave the effect in an uncertain state. Blindly
replaying it could duplicate a message, payment, file mutation, or command.
Skipping it could lose work that never completed.

Exactly-once behavior cannot be guaranteed for arbitrary external systems. This
is not a fundamental limitation on durable agent recovery: the runtime can
avoid silent replay, use idempotency where providers support it, and expose
uncertain effects explicitly.

## Recommended Solution

1. Give every tool call a stable invocation ID derived from the agent, run, and
   operation identity.
2. Persist invocation intent before dispatch, including a replay
   classification such as pure, idempotent, or non-idempotent.
3. Persist the tool result or effect receipt and the next checkpoint through
   one durable transition before allowing dependent work to continue.
4. Pass the stable invocation ID as an idempotency key when the target system
   supports one.
5. After restart, automatically replay only operations whose contract permits
   it. Mark uncertain non-idempotent effects as interrupted or indeterminate
   and require explicit recovery policy.
6. Fence late completions from an older Harness or sandbox generation so they
   cannot mutate a resumed run.
7. Add failure-injection tests for crashes before dispatch, during execution,
   after the external effect, after result persistence, and after checkpoint
   persistence.

## Acceptance Criteria

- Harness resumes from the last committed checkpoint without replaying a
  completed model operation.
- Idempotent tool adapters reuse the stable invocation ID across recovery.
- Non-idempotent effects in an uncertain crash window are never replayed
  silently.
- Late results from terminated Harness or sandbox generations are rejected.
- Cancellation and restart tests preserve an explicit interrupted or
  indeterminate outcome when effect completion cannot be established.

## Risk if Not Addressed

- External side effects may execute more than once after a crash.
- Completed effects may be lost from durable history.
- A late result may corrupt state after another runtime resumes the run.
- Stakeholders may infer stronger recovery guarantees than the implementation
  can provide.

## Out of Scope

- Claim leases and fencing between different provider devices.
- Exactly-once guarantees from external services that do not support
  idempotency.
- Automatic compensation or rollback for arbitrary external effects.
