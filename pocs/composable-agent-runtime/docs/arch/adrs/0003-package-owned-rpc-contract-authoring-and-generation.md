# ADR 0003: Package-Owned RPC Contract Authoring and Generation

Status: Proposed  
Date: 2026-08-04

## Context

Sync, Harness, and SDK each expose a typed RPC boundary. The wire schemas,
HRPC definitions, client APIs, handler types, bindings, and capability metadata
describe the same service but can drift when maintained independently.

The packages must remain independently versioned and must not depend on a
shared runtime-contract package. At the same time, each boundary needs one
concise source that reviewers can use to understand its methods and runtime
schemas without reading generated plumbing.

## Proposed decision

Each worker-owning package owns one concise declarative source of truth for its
RPC service contract. It defines the service methods together with their
request and response runtime schemas.

The package generates the repetitive boundary artifacts from that source:

- Hyperschema codecs;
- HRPC definitions;
- typed client functions;
- typed handler interfaces;
- client and server bindings;
- capability metadata.

Handlers remain ordinary functions that satisfy the generated handler
interface. Generated artifacts are derived outputs and are not edited as
independent contract authorities.

Persistence schemas remain separate from RPC contracts. A type appearing in
both domains is mapped explicitly rather than making the wire contract depend
on storage representation.

Each package owns its protocol identity, version, compatibility policy, and
migrations. Code generation does not infer whether a contract change is
compatible. Those decisions remain explicit and are covered by package-owned
compatibility tests.

The exact authoring API, file layout, and generator implementation are
implementation decisions. They may evolve without changing this ownership
model, provided each package retains one reviewable contract source and the
same generated guarantees.

In the PoC, Harness's package-owned service declaration covers skill
inventory, agent registration, run start and cancellation, run inspection,
available-work observation, state-port attachment, and suspend/resume
lifecycle operations. Its build derives the HRPC schema and public client
declarations from that declaration. The host state bridge remains a distinct
package-internal contract because it connects a packaged Harness worker to the
host-owned `HarnessRunStore`; it is not a consumer-facing Harness service.

## Consequences

### Positive

- Reviewers have one concise contract to inspect for each RPC boundary.
- Generated clients, handlers, bindings, and metadata cannot drift by being
  authored separately.
- Runtime validation and static types derive from the same service definition.
- Packages keep independent ownership without introducing protocol dependency
  cycles.
- Persistence evolution remains independent from wire-protocol evolution.

### Trade-offs

- Contract generation becomes part of each worker-owning package's build and
  release process.
- Generator changes require cross-package conformance coverage.
- Compatibility and migration decisions still require deliberate review.
- Some structural types may be duplicated across package boundaries.

## Alternatives considered

### Maintain schemas, HRPC definitions, and client types separately

This avoids generator work but preserves several sources of truth and permits
runtime schemas, clients, and handlers to drift.

### Put all RPC contracts in one shared package

This centralizes types but couples independently owned packages and can create
protocol dependency cycles. Small structural duplication is preferable.

### Generate contracts from persistence schemas

This reduces schema declarations but couples public wire compatibility to
storage layout and migration concerns.

## Relationship to compatibility

[ADR 0001](0001-package-owned-workers-and-compatibility.md) defines package-owned
workers, runtime compatibility, and final-artifact version validation. This ADR
defines how each package authors and derives its RPC boundary. Neither code
generation nor package semver replaces explicit protocol compatibility rules.

