# SDK Debt for High Stack Integration

- Status: Open
- Reviewed: 2026-10-29
- Scope: SDK, inference, and native packaging requirements for High Stack

## Context

High Stack is the proposed Composable QVAC Agent Stack. Its composition layer
connects state, agent execution, and optional capability runtimes to a shared
local inference runtime. Those consumers need independent lifecycles while using
the same model and native resources.

The monorepo already separates the direct Bare engine (`@qvac/inference`) from
host clients and worker packaging (`@qvac/sdk`). Request lifecycle management,
admission control, cancellation, and some host recovery behavior already exist.
The remaining debt concerns safe sharing, public inference contracts, host
coverage, and native packaging integration.

## Architectural direction

The engine owns inference and model resources; SDK hosts own client/worker
integration. The composition layer constructs the shared inference runtime and
supplies borrowed access to consumers. Native packaging responsibilities also
involve Fabric and the addon packages. Consumer identity and authorization need
an explicit division between the composition layer and engine rather than
assigning application policy to inference.

Exact APIs and implementation mechanisms remain open. The requirements below
identify missing features and incomplete integration or platform coverage.

## Outstanding requirements

### Safe shared inference

- **Consumer sessions and capability grants:** identify each consumer and enforce
  which inference operations it may perform.
- **Session-scoped cancellation:** prevent one consumer from cancelling another's
  requests, including through model-wide cancellation.
- **Shared model leases:** keep a model available while another consumer still
  needs it; distinguish releasing a consumer's use from unloading the model.
- **Borrowed access without root teardown:** closing a consumer must release only
  its resources; runtime shutdown remains the lifecycle owner's responsibility.
- **Per-consumer limits and diagnostics:** attribute queued work, active requests,
  model usage, and resource consumption without exposing private content.

### Public inference and capability contracts

- **Versioned runtime connections:** provide a supported connection contract for
  consumers of an existing shared inference runtime, with compatibility checks
  and explicit ownership across supported host transports.
- **Request-scoped diffusion cancellation:** expose operation identity and
  cancellation without targeting all work on a model.
- **Inference conformance across hosts:** verify compatible request, result,
  streaming, cancellation, and error behavior through direct inference and SDK
  host paths, including use by concurrent consumers.

### Inference readiness and recovery

- **Separate inference readiness states:** distinguish runtime availability,
  capability availability, and model readiness so consumers can decide when to
  start their own work.
- **Startup and operation deadlines:** bound runtime startup, RPC, model loading,
  and generation, including stalled streams; expiry must cancel work and clean up.
- **Generation-aware runtime access:** fail interrupted calls explicitly and
  preserve borrowed access or expose an explicit reconnect path after replacement.
- **Model state after recovery:** expose lost model state and invalidated handles
  so consumers can determine when inference is usable again.
- **Mobile lifecycle coverage:** complete worker-death detection and the defined
  recovery behavior across SDK mobile hosts, with lifecycle signals available to
  the owning application or composition layer.
- **Structured failure reporting:** preserve inference failure causes across host
  boundaries and distinguish recoverable interruption from terminal failure.
- **Stream recovery semantics:** specify which inference subscriptions terminate
  and which reconnect after replacement. Recovery must not silently replay
  interrupted inference requests.

### Native packaging and application selection

- **Multi-worker native dependency composition:** allow SDK packaging to coexist
  with other workers' compatible native dependencies without overwriting or
  omitting them.
- **Supported capability/configuration discovery:** expose the information needed
  for composition without duplicating private configuration rules or inferring
  capability names from package paths.
- **Backend selection metadata and controls:** describe platform-specific backend
  requirements, including shared Fabric dependencies, and support the declared
  accelerator selection or explicitly reject unsupported choices.
- **Artifact verification:** check actual native contents, backend availability,
  and size against application configuration; recorded selections alone are not
  evidence that packaging honored them.

### Native inference crash containment

- **iOS containment:** establish a supported, validated native inference failure
  boundary; independent inference process isolation remains unproven.
- **Host-specific guarantees:** document and validate what survives native crashes,
  resource exhaustion, and worker termination for each supported SDK host. Desktop
  recovery and Android service isolation do not establish mobile worklet parity.

## Evidence needed for adoption

Validation must exercise concurrent consumers, cancellation and failure during
active work, runtime replacement, model-state loss, and compatibility through the
supported inference entry points. Native artifact contents and crash-containment
claims need evidence from real builds and workloads on each target host. Package
tests and successful PoC demos establish only the boundaries they actually
exercise.

## References

- **Primary design source:** Composable QVAC Agent Stack QIP v2 (Draft) and its
  High Stack PoC, revision `6c51f97`.
- **SDK implementation background:** [QVAC architecture](../architecture/ARCHITECTURE.md)
  and [Bare inference engine](../../packages/inference/README.md).
- **SDK design principles:** [QVAC architectural principles](../architecture/PRINCIPLES.md).
- Implementation baseline: QVAC monorepo revision `df75dd2ca`.
