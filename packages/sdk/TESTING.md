# SDK Test Buckets

The SDK test suite is split into three clearly separated buckets. Each bucket has its own runtime, framework, and location. New tests **must** land in the correct bucket.

## Buckets

| Bucket | Runtime | Framework | Location | Command |
|--------|---------|-----------|----------|---------|
| **Unit** | Bun / Node | brittle | `test/unit/` | `bun run test:unit` |
| **Server (Bare)** | Bare | brittle | `test/bare/` | `bun run test:bare` |
| **Client (consumer)** | Node (desktop) / RN (mobile) | @tetherto/qvac-test-suite | `e2e/` | See [below](#e2e--clientconsumer-e2e-tests) |

## Where new tests must land

### `test/unit/` — Unit tests (Bun/Node)

Tests that exercise **shared schemas, client logic, utilities, and any code that does NOT require the Bare runtime**. These run with `bun run` directly on TypeScript sources.

**Belongs here if:**

- Tests Zod schemas, type validation, or shared utilities
- Tests client-side logic (RPC client, API surface, config resolution)
- Tests code importable without N-API bindings or `bare-*` packages that reference `Bare.platform`
- Uses only polyfill-compatible bare packages (e.g., `bare-abort-controller`)

**Does NOT belong here if:**

- Requires `bare-fs`, `bare-path` (with `Bare.platform`), `bare-process`, `bare-crypto`, or other N-API bare modules
- Dynamically imports addon plugins (`@/server/bare/plugins/*`)
- Tests server-side ops that call into native addon bindings

### `test/bare/` — Server tests (Bare runtime)

Tests that exercise **server-side code requiring the Bare runtime** — addon plugin manifests, ops that use bare-fs/bare-path, the KV cache session, archive extraction, and registry-driven inference cancel flows.

**Belongs here if:**

- Imports `bare-fs`, `bare-path`, `bare-process`, `bare-crypto`, or other Bare-specific N-API modules
- Tests server-side ops (`@/server/bare/ops/*`)
- Tests addon plugin manifests or handlers (`@/server/bare/plugins/*`)
- Requires native addon bindings that only resolve in Bare

**How it runs:** TypeScript is compiled to JS via `tsc`, `@/` aliases are resolved via `tsc-alias`, then `brittle-make-test` generates an entrypoint (`all.mjs`) and `brittle-bare` runs it.

### `e2e/` — Client/consumer e2e tests

Tests that exercise the **full SDK from the consumer perspective** — loadModel, completion, transcription, etc. These run on real devices (iOS, Android) and desktop via the `@tetherto/qvac-test-suite` framework.

**Belongs here if:**

- Tests the public SDK API as a consumer would use it
- Needs a running Bare worker process (server) behind the scenes
- Validates end-to-end flows (download → load → inference → unload)
- Tests mobile-specific or desktop-specific consumer behavior

See [e2e/README.md](./e2e/README.md) for the full structure and local run instructions.

## Running tests

```bash
# Unit tests (Bun/Node)
bun run test:unit

# Bare runtime tests
bun run test:bare

# Security tests (subset of unit tests, path-traversal/path-security)
bun run test:security

# Security tests under Bare (same tests compiled and run via brittle-bare)
bun run test:security:bare
```

For client e2e tests, see [e2e/README.md](./e2e/README.md).

## Shared

- `test/mocks/` — Shared mock data used by unit tests
- `test/fixtures/` — Test fixture files (e.g., malicious tar archives for security tests)
