# TD: Structural Composition Ports

## Problem

The reusable `StatePort` and `ModelPort` boundaries are not exposed as complete
consumer integrations. Sync-backed Harness state is assembled inside Assistant,
and SDK adaptation is embedded in Harness. Direct Harness-plus-Sync and
Agents-plus-SDK consumers must reconstruct internal composition behavior.

## Recommended Solution

Make Harness own a minimal `StatePort` plus a helper for a structurally
compatible Sync client. Make Agents own a minimal `ModelPort` plus a helper for
an SDK client or another local provider. Keep Sync unaware of Harness and SDK
unaware of Agents. Add package-level type checks, runtime validation for dynamic
clients, and clean-consumer tests for both direct compositions.

