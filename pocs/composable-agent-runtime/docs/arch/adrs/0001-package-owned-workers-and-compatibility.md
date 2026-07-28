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

The
[interactive deployment and package composition map](https://packages-deployment-options-demo.netlify.app/)
shows how this ownership rule applies to Assistant-managed and direct package
entry points.

Where supported, TypeScript, Python, Swift, and Kotlin bindings are generated
from the same worker contract. They are client implementations inside an
application host, not separate deployment hosts. Each supported client
distribution installs its matching worker artifacts. A client that requires a
separately installed worker is outside this proposed decision and requires an
explicit exception or a superseding ADR.

### Verify package-owned workers during initialization

Packaging a client with its matching worker removes the need for local version
negotiation. During initialization, the client starts the packaged worker and
verifies:

- readiness;
- contract identity;
- exact protocol version.

Initialization fails with a compatibility error if either identity or protocol
does not match, and API operations cannot proceed until readiness succeeds.
Build and runtime identities remain diagnostic and do not determine
compatibility. Package versions are not negotiated over local RPC.

### Separate compatibility from feature availability

The generic client-worker compatibility check does not represent every feature
available in a particular build or environment. Availability is reported
through separate, scoped inventories:

- packaged plugins and model types are build-dependent;
- execution backends are platform and hardware-dependent;
- model capabilities are resolved from the selected model.

A client may require configured plugins during initialization and fail if they
are absent. Backend support and model capabilities are checked when the
corresponding operation or model is selected, not as generic initialization
requirements.

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

The normal composed application stack creates one shared Inference worker.
Creating another independent SDK client and worker requires explicit
application composition; the stack does not create one implicitly for each
agent or Harness consumer. Explicit additional workers may duplicate model
memory or compete for compute resources.

Resource ownership is separate from dependency versioning. Explicitly composed
workers must fail fast if they attempt to own the same exclusive storage or
runtime resource.

## Alternatives considered

### Distribute workers independently

This permits separate upgrades but creates client-worker compatibility
matrices and makes local deployment harder for consumers.

### Validate only at the Assistant boundary

This does not protect direct Sync, Harness, or SDK consumers. Compatibility
checks belong to the package that owns each worker boundary.

### Negotiate package versions over RPC

Package versions do not express wire compatibility precisely. Local packaged
boundaries use contract identity and exact protocol version. Independently
deployed Sync peers additionally negotiate capabilities.

### Force one version of every shared dependency

Peer dependencies, aliases, or global overrides can force incompatible
libraries into one version. Singleton enforcement should be limited to
packages or native artifacts that genuinely share one execution realm.

## Acceptance criteria

Change this ADR to Accepted only after:

1. Sync, Harness, and SDK can each build and launch their package-owned worker.
2. Direct consumers and Assistant-managed composition pass clean-install tests.
3. Contract and protocol mismatches fail before readiness.
4. A configured required plugin fails initialization when it is absent.
5. Cross-package CI covers the minimum and latest supported semver ranges.
6. Desktop and mobile packaging verifies duplicate versions in final
   artifacts.
7. Every supported language distribution installs its matching worker
   artifacts and uses the equivalent worker contract.
8. Assistant/Harness composition starts one shared Inference worker by
   default; another worker is created only through explicit application
   composition.

## Related material

- [Package-owned Bare-Stow runtimes](../tech-debt/TD-PACKAGE-OWNED-BARE-STOW-RUNTIMES.md)
- [Multilanguage RPC client generation](../tech-debt/TD-MULTILANGUAGE-RPC-CLIENT-GENERATION.md)
- [Mobile RPC contract parity](../tech-debt/TD-MOBILE-RPC-CONTRACT-PARITY.md)

