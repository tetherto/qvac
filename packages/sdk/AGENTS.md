# SDK guidance

Read [`CONTRIBUTING.md`](CONTRIBUTING.md), this package's README and manifest, and
the relevant files under `docs/` before changing a public or runtime contract.
Source code and tests win over historical agent notes.

- Keep the client portable. Bare-specific behavior belongs behind the server/worker
  boundary; code running under Bare must use compatible modules.
- Prefer small functions and composition. Use classes where the existing contract
  requires them, including structured error classes.
- Follow the package's established TypeScript, import-alias, and colocated-schema
  conventions. Shared client/server contracts use exported Zod schemas and inferred
  types.
- Keep client and server error layers separate, use structured errors, and preserve
  the original cause when translating failures. See [`docs/error-handling.md`](docs/error-handling.md).
- Treat exported constants, schemas, RPC shapes, streaming, cancellation, and model
  lifecycle behavior as public contracts. Update contract generation and focused
  tests when changing them.
- Treat `qvac serve` and `qvac configure` as first-class SDK products. A
  user-facing inference capability must include matching CLI support in the same
  PR, or the PR must explicitly explain why it is library-only. Native-addon PRs
  remain native; apply this requirement in the follow-up SDK exposure PR.
- For public constants consumed outside JavaScript, follow
  [`contract/README.md`](contract/README.md); an `index.ts` export alone is not
  sufficient.
- When runtime behavior changes, update the owning package documentation in place.
  Do not append corrections while leaving obsolete descriptions active.
- Inspect `package.json` and run the narrowest relevant format, lint, type, unit,
  integration, and contract checks before handoff.
