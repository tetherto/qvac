# SDK Test Buckets

The SDK test suite is split into two clearly separated buckets. Each bucket has its own runtime, framework, and location. New tests **must** land in the correct bucket.

## Buckets

| Bucket                | Runtime                                 | Framework             | Location | Command                                     |
| --------------------- | --------------------------------------- | --------------------- | -------- | ------------------------------------------- |
| **Unit**              | Bun / Node                              | brittle               | `test/`  | `bun run test:unit`                         |
| **Client (consumer)** | Node (desktop) / Electron / RN (mobile) | @qvac/qvac-test-suite | `e2e/`   | See [below](#e2e--clientconsumer-e2e-tests) |

The Bare-runtime engine and its server-side tests live in `@qvac/inference`; the SDK consumes that package and no longer hosts an in-process engine test bucket.

## Where new tests must land

### `test/` — Unit tests (Bun/Node)

Tests that exercise **shared schemas, client logic, utilities, and the SDK's own worker orchestration**. These run with `bun run` directly on TypeScript sources.

**Belongs here if:**

- Tests Zod schemas, type validation, or shared utilities
- Tests client-side logic (RPC client, API surface, config resolution)
- Tests the SDK's worker lifecycle, plugin registration, or model-update tooling
- Tests code importable without N-API bindings or `bare-*` packages that reference `Bare.platform`

**Does NOT belong here if:**

- It exercises the in-process inference engine — engine behavior is tested in `@qvac/inference`

### `e2e/` — Client/consumer e2e tests

Tests that exercise the **full SDK from the consumer perspective** — loadModel, completion, transcription, etc.
These run on desktop Node, packaged Electron apps, and real devices (iOS, Android) via the
`@qvac/qvac-test-suite` framework.

**Belongs here if:**

- Tests the public SDK API as a consumer would use it
- Needs a running Bare worker process (server) behind the scenes
- Validates end-to-end flows (download → load → inference → unload)
- Tests mobile-specific or desktop-specific consumer behavior
- Tests Electron packaged-app behavior, including `process.resourcesPath` worker/config resolution

See [e2e/README.md](./e2e/README.md) for the full structure and local run instructions.

## Running tests

```bash
# Unit tests (Bun/Node)
bun run test:unit
```

For client e2e tests, see [e2e/README.md](./e2e/README.md).

## Shared

- `test/mocks/` — Shared mock data used by unit tests
- `test/fixtures/` — Test fixture files (e.g., worker scripts used by lifecycle tests)
