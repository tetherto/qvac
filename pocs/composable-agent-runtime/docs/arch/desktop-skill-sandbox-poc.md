# Desktop skill sandbox PoC evidence

Evidence collected on 2026-07-30 and extended with real Obsidian validation on
2026-08-04 on macOS/Darwin 25.5.0. Commands use placeholders so this document
is safe to publish.

## Status

Weather, Obsidian, image generation, deterministic packaging, and real
Seatbelt conformance passed.

## Architecture and data flow

```text
Qwen agent registration
  -> Harness policy gate
     -> http_request / exec
        -> one lazy Seatbelt child per agent
           -> authenticated loopback Weather proxy
           -> approved read-only official Obsidian CLI argv
     -> generate_image
        -> shared in-process SDK broker
           -> the same SDK instance and diffusion plugin
           -> owner-only atomic PNG attachment
```

Harness exposes only schemas that are both granted by a selected skill and
allowed by agent policy. A missing registered schema fails closed. Obsidian
validation occurs before approval, and one approval decision is memoized for
the complete invocation so independent policy and executor checks cannot prompt
twice.

## Seatbelt boundary

The generated profile starts with `deny default`. Code and data authority are
separate:

- the packaged sandbox code root is the only directory granted
  `file-map-executable`;
- selected skill resources and the configured Obsidian vault receive read-only
  data access and never appear in executable-map rules;
- the canonical native Bare binary and approved CLI executable are exact
  executable files;
- each agent receives an owner-only scratch directory;
- outbound network access is limited to the exact loopback Weather proxy port
  when Weather is selected.

Selected skill files are materialized under unpredictable owner-only
per-runtime and per-agent directories. The runtime never adopts a pre-created
path. It verifies uid and modes, gives two agents distinct roots even for the
same selection, reuses an agent's tree across idle sandbox generations, and
removes every owned tree during tooling shutdown.

The real generic Seatbelt probe passed 13 of 13 assertions across its baseline
and two-agent cases. Both live children were denied the other agent's resource
file and scratch file. The probe also confirmed that an active generation is
not closed by idle expiry, then observed lazy restart from generation 1 to
generation 2 after teardown. The separate real desktop executor probe uses a
synthetic Weather upstream behind the authenticated host proxy. It validates
the Seatbelt and proxy path, but it is not evidence of live external Weather.

`sandbox-exec` is deprecated and is not a stable product API. These results
apply only to Darwin 25.5.0. A production design should use a supported signed
helper, XPC service, or equivalent boundary while retaining the deny-by-default
conformance tests.

## Sandbox lifecycle

The registry keeps at most one live sandbox generation per agent and starts it
lazily. The default idle timeout is 60 seconds and configuration is bounded to
1 millisecond through 15 minutes. The timer resets only after an invocation
settles. Active invocations prevent teardown. An expiry closes only the
captured current generation. The registry removes that slot before awaiting
process close, so a concurrent next request immediately starts the next
monotonic generation.

Harness run-registry shutdown is also bounded. It cancels live runs, waits for
terminal removal, and surfaces a 10-second drain timeout instead of hanging
indefinitely.

## Weather egress

Every initial and redirected destination must remain credential-free HTTPS on
the exact `wttr.in` hostname and default port. For every hop the host proxy:

1. resolves the hostname;
2. rejects empty answers and any loopback, private, link-local, multicast,
   documentation, benchmark, or reserved IPv4/IPv6 address;
3. pins one validated address into the actual TLS connection while preserving
   `wttr.in` as the SNI and HTTP Host value;
4. applies response, redirect, and timeout bounds.

Node connects directly to the pinned address with `servername=wttr.in`. Bare
uses the runtime-correct `bare-tcp` lookup contract to return only the pinned
address while `bare-tls` receives `host=wttr.in` for SNI and certificate
verification. A controlled local TLS integration test covers Node and Bare
connection pinning, observed SNI and Host identity, response parsing,
cancellation, and wrong-host certificate rejection without disabling
verification.

DNS shims expose the same one-argument lookup API in Node and Bare. Selection
is deterministic: public IPv4 addresses sort first, then public IPv6. Each
agent receives a distinct proxy bearer token bound to its agent-specific route.
The token is sent to the child over HRPC, not argv, environment, or the
Seatbelt profile.

Residual DNS limitation: the PoC trusts the operating system resolver and does
not perform DNSSEC validation or independently authenticate DNS provenance.
Address pinning removes the lookup-to-connect rebinding window for each hop.
TLS hostname verification remains the final defense if a resolver returns a
malicious public address.

## Image output

Image generation stays in the single shared SDK runtime. Persistence requires
a bounded PNG with a valid signature, an `IHDR` first chunk, and `IHDR`
dimensions equal to the requested dimensions. Files are written atomically
under an owner-only runtime namespace with mode `0600`; partial files are
removed on failure or cancellation.

The real diffusion smoke requires both `QVAC_REAL_MODEL_SMOKE=1` and an explicit
`QVAC_DIFFUSION_MODEL`. It derives attachment storage from the runtime
temporary directory and contains no user path, task-specific temporary path,
or hashed model filename.

## Obsidian status and preflight exception

The runner allows only `files`, `search`, `read`, `daily:read`, and `version`.
Mutation commands are rejected before approval or sandbox launch, and the vault
is read-only in the runner profile.

The bounded `obsidian version` and `vault info=name|path` preflight probes run
unsandboxed in the trusted host before an agent invocation exists. They are an
explicit exception to per-invocation approval. The exception is limited to
fixed read-only argv built from canonical configured values, bounded
time/output, and exact vault identity/root verification. User-provided command
arguments never enter these probes.

Real Obsidian passed with the official registered CLI and an explicitly
approved test vault. The CLI crossed Seatbelt through a path-scoped outbound
grant to the running app's `~/.obsidian-cli.sock`; no TCP grant was added. Qwen
selected `exec`, the CLI returned the two expected Markdown files, and the run
shut down cleanly:

- model load: 1,185 ms;
- first tool call: 2,786 ms elapsed;
- sandbox ready: 12,316 ms elapsed;
- tool execution including sandbox startup: 10,539 ms;
- final response: 14,838 ms elapsed;
- shutdown: 111 ms;
- exit: 0.

The Electron application binary was not used as the CLI.

## SDK 0.15 cancellation limitation

Completion cancellation is wired because `completion()` synchronously returns
a request id. Diffusion generation can be cancelled after the model id exists.
SDK 0.15 `loadModel()` accepts no abort signal or request handle and returns
only the final model id, so an in-progress model load cannot be safely cancelled
through the public API. Harness records cancellation immediately, suppresses
late progress/results, and does not start generation after an aborted load, but
the native load may continue until `loadModel()` settles.

## Final verification

- Desktop runner: 24 tests, 127 expectations.
- Focused sandbox suite: 88 Bun tests, 380 expectations; generic real
  Seatbelt probes 13 of 13; real desktop executor probe 13 of 13.
- Root typecheck and supervisor lint passed.
- Clean tarball installation passed for supervisor, agents, sync, harness,
  assistant, and skill-cli.
- Full `bun run verify` exited successfully in 526,823 ms.
- `git diff --check` and IDE diagnostics were clean.

## Current live Weather evidence

The final code was rerun with Qwen 3.6 35B and the real `wttr.in` service. Qwen
selected `http_request`, the request crossed the real Seatbelt child and
agent-fenced proxy, and the model answered: "The current weather in London is
sunny with a temperature of +16°C."

- model load: 15,104 ms;
- first tool call: 17,776 ms elapsed;
- sandbox ready: 26,841 ms elapsed;
- tool execution including sandbox startup: 10,167 ms;
- final response: 29,880 ms elapsed;
- shutdown: 98 ms;
- exit: 0.

## Commands

```bash
cd pocs/composable-agent-runtime/apps/skill-cli
bun run build:sandbox
bun run smoke -- --timeout-ms=5000
```

```bash
export QVAC_QWEN_MODEL="<absolute-qwen-gguf>"
export QVAC_BARE_EXECUTABLE="<absolute-native-bare-binary>"
export QVAC_SANDBOX_ENTRY="<absolute-built-entry.bundle>"
export QVAC_ATTACHMENT_BASE="<absolute-output-directory>"
export QVAC_DIFFUSION_MODEL="<absolute-diffusion-gguf>"
export QVAC_DIFFUSION_PREDICTION="v"

bun run real:weather -- --timeout-ms=600000
bun run real:image -- --timeout-ms=900000
bun run real:all -- --timeout-ms=900000
```

The final hardening wave reran live Qwen Weather because the Bare HTTPS
transport changed. Stable Diffusion was not rerun because diffusion model
loading, generation, and persistence behavior did not change in this wave.
