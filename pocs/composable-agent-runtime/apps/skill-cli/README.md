# Desktop skill runner

Private macOS PoC runner for the bundled Weather, Obsidian, and image-generation
skills. It starts the package-owned Harness lifecycle, which owns one shared
SDK runtime and routes desktop tools through per-agent Seatbelt children.

## Deterministic smoke

```bash
bun run smoke -- --timeout-ms=5000
```

The smoke command uses only a deterministic fake Harness and fake executors.

## Real model-driven runs

Set explicit paths before running. The runner has no user-specific defaults.

```bash
export QVAC_QWEN_MODEL="<absolute-path-to-qwen-gguf>"
export QVAC_BARE_EXECUTABLE="<absolute-path-to-native-Mach-O-bare>"
export QVAC_ATTACHMENT_BASE="<absolute-output-directory>"
export QVAC_DIFFUSION_MODEL="<absolute-path-to-diffusion-gguf>"
export QVAC_DIFFUSION_PREDICTION="v"

bun run real:weather -- --timeout-ms=600000
bun run real:image -- --timeout-ms=900000
bun run real:all -- --timeout-ms=900000
```

`real:all` reports a partial result when Obsidian is unavailable. A real
Obsidian run additionally requires an official registered CLI and explicit
approval:

```bash
export QVAC_OBSIDIAN_CLI="<absolute-path-to-official-obsidian-cli>"
export QVAC_OBSIDIAN_VAULT_ROOT="<absolute-vault-root>"
export QVAC_OBSIDIAN_VAULT="<exact-vault-identity>"
export QVAC_APPROVE_OBSIDIAN="true"

bun run real:obsidian -- --timeout-ms=600000
```

Preflight requires Mach-O executable validation plus an exact bounded Bare
runtime probe. It also requires the official CLI version probe and binds the
exact vault identity to the canonical root with read-only
`vault info=name|path` probes.
These fixed read-only preflight probes run unsandboxed in the trusted host
before an invocation exists, so they are an explicit exception to
per-invocation approval. They accept only canonical configured values and keep
strict time and output bounds.
The runner allows only `files`, `search`, `read`, `daily:read`, and `version`.
Mutation commands are rejected before approval or sandbox launch, and the vault
is mounted read-only in the Seatbelt profile. The reusable Harness executor
retains its read/write mode for non-runner consumers.
Trusted Obsidian argv always places `vault=<identity>` first, before the
operation, as required by the official CLI.

The Electron application binary and script-wrapped Bare launchers are
intentionally rejected. Each run writes redacted, field-allowlisted JSON-line
lifecycle events to stdout and one concise result to stderr. Weather bodies,
Obsidian output, model/vault/executable paths, environment tokens, and raw SDK
errors are never included in public events.

Per-agent sandboxes start lazily and close after 60 seconds without a live
invocation. The bounded timeout resets after each completed invocation, never
closes active work, and a later call starts the next fenced generation.
Weather resolves and validates public addresses on every redirect, then pins
the selected address into the TCP connection while TLS SNI and certificate
verification retain `wttr.in`. DNS selection prefers public IPv4 and falls back
to public IPv6. Each child token is bound to its agent-specific proxy route.
The operating system resolver is trusted; this PoC does not add DNSSEC
validation.
