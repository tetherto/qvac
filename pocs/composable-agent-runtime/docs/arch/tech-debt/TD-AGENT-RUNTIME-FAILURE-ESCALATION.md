# TD: Agent Runtime Failure Escalation

## Problem

Failure propagation is incomplete after local recovery is exhausted. Assistant
emits `gave-up` but remains partially available, and later calls fail with
`Child not running`. Sync's internal storage and network children use
`restart: never`, but their terminal failures are not consistently escalated
to the outer Sync process. Active watches also end when their runtime is
replaced.

The structured `recoverable` error field is descriptive only and does not
currently control recovery behavior.

## Recommended Solution

Define explicit healthy, degraded, recovering, and failed states for each
runtime and the Assistant facade. Escalate unrecoverable nested failures to the
owning runtime boundary, expose terminal state through inspection and lifecycle
events, and make subsequent API calls fail with the original structured cause.
Document which streams terminate and which operations reconnect after recovery.
