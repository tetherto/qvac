# ADR 0001: Package-Owned Workers and Compatibility

Status: Proposed  
Date: 2026-07-28

## Context

Assistant, Harness, Sync, SDK, and Inference may be released independently
while still composing in one local application. Harness, Sync, and Inference
also execute across JavaScript runtime boundaries.

The PoC demonstrates local HRPC communication and fail-closed compatibility
checks, but it does not establish the production packaging or versioning
policy. In particular, the following are proposals rather than agreed
decisions:

- publishing a client with its matching worker;
- making the worker-owning package responsible for `bare-stow` assembly and
  spawning;
- relying on semver and cross-package CI for package API compatibility.

This ADR records those proposals so they can be reviewed and validated
explicitly.

## Proposed decision

### Package the client and worker together

Each package that owns a worker publishes its public client together with the
matching worker artifacts:

- `@qvac/sync` owns the Sync client and worker;
- `@qvac/harness` owns the Harness client and worker;
- `@qvac/sdk` owns its clients and the matching `@qvac/inference` worker
  artifacts.

The owning package also owns `bare-stow` assembly, platform packaging, spawn
lifecycle, and readiness checks. Workers are not installed or upgraded as
independent local services.

TypeScript, Python, Swift, and Kotlin bindings follow the same worker contract.
They are client implementations inside an application host, not separate
deployment hosts.

### Validate every client-worker boundary

Before exposing a public client as ready, the worker reports:

- contract identity;
- exact protocol version;
- supported capabilities;
- build version;
- runtime identity.

The client rejects the wrong contract or protocol version and verifies all
required capabilities. Missing optional capabilities do not block readiness;
callers check capability availability before using those features. Build and
runtime identities are diagnostic and do not determine compatibility.

Package versions are not negotiated over local RPC.

### Use semver for package composition

If this ADR is accepted, independently published 0.x packages use semver for
their public package APIs:

- breaking public changes require a minor release;
- composing packages use declared compatible ranges;
- cross-package CI tests the minimum and latest versions allowed by each
  range.

This policy requires validation against clean consumer installations before
the ADR can be accepted.

### Treat Sync peers differently

Sync peers may run different releases on different devices. Their handshake
therefore negotiates a supported protocol window and capabilities, then
enforces replicated-schema and local-data migration rules.

### Keep structural ports in process

`StatePort` and `ModelPort` remain in-process structural contracts. They use
type checking and runtime shape validation rather than version handshakes.

### Validate packaged artifacts, not only installations

Duplicate versions may exist in an installed dependency graph without entering
the application artifact. Packaging should enforce:

- at most one selected package version within one execution realm;
- one version of each native addon within a mobile or desktop artifact;
- duplicate private dependencies are allowed across isolated worker bundles;
- incompatible versions must not be silently collapsed through aliases or
  dependency overrides.

Supervisor remains an ordinary lifecycle library, not an application-wide
singleton. Separate workers may use independent Supervisor versions and
instances.

## Consequences

### Positive

- Consumers install one package for a client and its matching worker.
- Direct and composed consumers receive the same compatibility checks.
- Local protocol drift fails before public operations become available.
- Worker implementation details remain isolated behind generated clients.
- Installed duplicates that are not reachable from an artifact do not cause
  unnecessary build failures.

### Trade-offs

- Client and worker releases become coupled.
- Packages carry platform-specific worker artifacts.
- Separate worker bundles may repeat private dependencies.
- Semver ranges need ongoing minimum-version and latest-version CI coverage.
- Multiple independent Inference workers remain possible and may duplicate
  model memory or compete for compute resources.

Resource ownership is separate from dependency versioning. Two workers must
fail fast if they attempt to own the same exclusive storage or runtime
resource.

## Alternatives considered

### Distribute workers independently

This permits separate upgrades but creates client-worker compatibility
matrices and makes local deployment harder for consumers.

### Validate only at the Assistant boundary

This does not protect direct Sync, Harness, or SDK consumers. Compatibility
checks belong to the package that owns each worker boundary.

### Negotiate package versions over RPC

Package versions do not express wire compatibility precisely. Contract
identity, protocol version, and capabilities provide the runtime decision.

### Force one version of every shared dependency

Peer dependencies, aliases, or global overrides can force incompatible
libraries into one version. Singleton enforcement should be limited to
packages or native artifacts that genuinely share one execution realm.

## Acceptance criteria

Change this ADR to Accepted only after:

1. Sync, Harness, and SDK can each build and launch their package-owned worker.
2. Direct consumers and Assistant-managed composition pass clean-install tests.
3. Contract, protocol, and required-capability mismatches fail before
   readiness.
4. Cross-package CI covers the minimum and latest supported semver ranges.
5. Desktop and mobile packaging verifies duplicate versions in final
   artifacts.
6. TypeScript, Python, Swift, and Kotlin clients use equivalent worker
   contracts where those clients are supported.

## Related material

- [Local deployment and contract design](../../../../../arch/qips/agentic-sdk-local-deployment-and-contract-design.md)
- [Composable Agent Runtime QIP](../../../../../arch/qips/agentic-sdk-p2p-layering.md)
- [SDK and Inference split](../../../../../arch/qips/sdk-split-to-core-sdk.md)
- [Package-owned Bare-Stow runtimes](../tech-debt/TD-PACKAGE-OWNED-BARE-STOW-RUNTIMES.md)
- [Multilanguage RPC client generation](../tech-debt/TD-MULTILANGUAGE-RPC-CLIENT-GENERATION.md)
- [Mobile RPC contract parity](../tech-debt/TD-MOBILE-RPC-CONTRACT-PARITY.md)

