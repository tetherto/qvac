# TD: Mobile Agent Runtime Recovery

## Problem

The mobile feasibility host does not use the desktop Supervisor policy.
Unexpected Harness or SDK death leaves RunnerBroker in `died`, while Sync
disconnect leaves the application `offline`. Recovery requires an explicit
host action. Android process isolation is proven, but bounded automatic restart
and reconnection are not implemented. This creates different lifecycle
behavior between desktop and mobile.

## Recommended Solution

Apply the same host-owned lifecycle state machine on mobile with bounded
restart attempts, exponential backoff, dependency ordering, and explicit
reconnect behavior. Stop after the retry budget is exhausted and require user
or application intervention. Runtime recovery must not automatically replay
in-flight tasks.
