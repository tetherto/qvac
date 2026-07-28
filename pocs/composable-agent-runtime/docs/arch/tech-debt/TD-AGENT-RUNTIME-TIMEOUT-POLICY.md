# TD: Agent Runtime Timeout Policy

## Problem

The composable agent runtime PoC has no timeout for desktop sidecar readiness,
HRPC calls, model loading, or LLM completion. The Supervisor's five-second
stall timer only emits a diagnostic event and does not cancel the operation.
Mobile adds separate five-second broker and ten-second Android service
timeouts, so timeout behavior differs by host.

## Recommended Solution

Define one cross-runtime timeout policy with separate, configurable deadlines
for startup, RPC requests, model loading, and inference. Every timeout should
cancel the underlying work, clean up its transport resources, and propagate a
typed error containing the failed boundary and trace ID.
