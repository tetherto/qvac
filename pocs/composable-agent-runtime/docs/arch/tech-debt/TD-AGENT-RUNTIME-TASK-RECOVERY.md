# TD: Agent Runtime Task Recovery

## Problem

Task execution has no retry or replay policy. A runtime or inference failure
marks the task as failed after one attempt. Tasks left in `running` state are
reported after service restart but are not resumed, reset, or resolved. Silent
replay would also be unsafe because the current task contract has no attempt
identity, lease, or idempotency guarantee.

## Recommended Solution

Keep retry policy application-owned, but add the contracts needed to implement
it safely: attempt IDs, retryable error classification, stale-task recovery,
and idempotency or lease fencing where duplicate execution matters. Never
silently replay interrupted work. Require the application to explicitly retry,
fail, or abandon each stale attempt.
