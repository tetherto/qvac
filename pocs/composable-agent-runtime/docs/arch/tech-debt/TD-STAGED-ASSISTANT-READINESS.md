# TD: Staged Assistant Readiness

## Problem

The PoC starts Sync before Harness and keeps SDK/model startup lazy, but it does
not expose those stages to applications. `assistant.state` operations wait for
the root Supervisor, so local state and device identity remain blocked until
both Sync and Harness are ready. A Harness startup problem can therefore make
otherwise healthy local state unavailable.

Network connectivity is also a separate concern and must not become part of
local readiness.

## Recommended Solution

Expose independent readiness gates:

1. `assistant.state.ready()` waits only for local Sync storage and identity.
2. `assistant.ready()` waits for Harness and its state integration, but does not
   start SDK or load a model.
3. Model readiness is keyed by model and occurs lazily on `run()`, with an
   optional explicit preparation API for warm-up.

State operations should resolve the current Sync generation after recovery.
Inference failure must not make local state unavailable, and no interrupted run
should be replayed automatically.
