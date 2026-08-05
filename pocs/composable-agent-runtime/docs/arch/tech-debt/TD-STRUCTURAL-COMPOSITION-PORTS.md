# TD: Structural Composition Ports

## Problem

The reusable `ModelPort` boundary is not exposed as a complete consumer
integration. SDK adaptation is embedded in Harness, so Agents-plus-SDK consumers
must reconstruct internal composition behavior.

The Harness-to-Sync half is addressed: Harness owns `DurableStatePort`, a narrow
in-process durable-work state boundary, plus the private adapter from that port
to `HarnessRunStore`. Sync-backed composition is now structural: Assistant wires
`sync.state` into Harness, Harness opens the durable-work profile through its
own contract, and `packages/harness` does not depend on `@qvac/sync`.

## Recommended Solution

Make Agents own a minimal `ModelPort` plus a helper for an SDK client or another
local provider. Keep SDK unaware of Agents. Add package-level type checks,
runtime validation for dynamic clients, and clean-consumer tests for direct
Agents-plus-SDK composition.

