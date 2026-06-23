# bare-sdk bare e2e suite

A small, high-value suite that exercises `@qvac/bare-sdk` through its public entry point on the Bare runtime. The full `@tetherto/qvac-test-suite` covers the Node (desktop) and React Native (mobile) RPC routes; this suite exists to cover the third route: the in-process `bare-client` transport that `@qvac/bare-sdk` resolves `#rpc` to.

Assertions use `brittle`, the de-facto test framework for the Bare runtime.

Tests import the package by its published name (`@qvac/bare-sdk`, `@qvac/bare-sdk/plugins`, `@qvac/bare-sdk/<addon>/plugin`) so resolution goes through the real `exports`/`imports` maps a consumer would use. A `node_modules/@qvac/bare-sdk` self-symlink (created by `scripts/link-self.mjs`, run automatically by the test scripts) makes that name resolvable in-tree.

## Two lanes

| Lane | Script | Models / addons | Where it runs |
|------|--------|-----------------|---------------|
| Assembly gate | `test:bare` | none | every PR (cheap) |
| Inference e2e | `test:bare:e2e` | downloads models, needs addon prebuilds | label-gated CI (`test-e2e-full`) |

`test:bare` runs only `assembly.test.ts`: it confirms an SDK call before any `registerPlugin()` fails fast, with **no** addon install or model download.

`test:bare:e2e` runs `e2e/*.test.ts`, which register the llama.cpp / nmtcpp plugins and run real inference. The capabilities are chosen to cover distinct bare-client transport shapes:

- `completion.test.ts` — token stream
- `embedding.test.ts` — unary send/response
- `translation.test.ts` — a second addon (nmtcpp), proving more than the llama.cpp path works
- `transcribe-stream.test.ts` — duplex (`createDuplexSession`): streams audio in and reads transcription events back; the only transport the others miss

The duplex test reads a committed WAV fixture (`e2e/assets/two-speakers-16k.wav`, reused from the SDK e2e assets), decodes it to f32le mono via `_lib/wav-pcm.ts`, and streams it in chunks plus trailing silence. The assertion is tolerant (events flowed + non-empty transcript) since ASR output isn't byte-deterministic.

On Bare, `unloadModel` leaves the in-process worker running by default (a long-lived consumer survives a routine unload), so per-test teardown unloads without closing. `e2e/suite-teardown.ts` closes the connection once after the whole suite — without it the event loop never drains and the run hangs. Closing per test isn't an option: it runs `cleanupForTerminate` (clears plugins, destroys the swarm) and the shared worker can't be revived for the next test. The file isn't a `*.test.ts`, so the capability glob skips it; `make:test:bare:e2e` appends it as a trailing glob arg so it loads last regardless of filesystem order.

## Running locally

Prereqs: a built `../sdk` (the bundle step copies from it), the `bare` runtime, and — for the e2e lane — the addon prebuilds for your platform.

```bash
cd packages/bare-sdk

# Assembly gate only (no models, no addons):
npm run test:bare

# Inference e2e — install the addons this suite uses, then run:
npm install --no-save @qvac/llm-llamacpp @qvac/embed-llamacpp @qvac/translation-nmtcpp @qvac/transcription-whispercpp
npm run test:bare:e2e
```

Addons are installed with `--no-save` on purpose: `@qvac/bare-sdk` does not declare addon packages in `dependencies`, `optionalDependencies`, or `peerDependencies`. They are also kept out of committed `devDependencies` so the always-on assembly lane stays light.

## CI

The assembly lane runs on every PR via the "SDK Pod Checks" rollup: `bare-sdk` is registered in `.github/sdk-pod-checks.json` with `tests_bare: true`, so the harness runs `test:bare`. Its `sdk-source:workspace` script (`scripts/build-sibling-sdk.mjs`) builds `../sdk/dist` first, which `bundle-from-sdk` copies from.

The inference lane runs as a label-gated job in `.github/workflows/on-pr-bare-sdk-e2e.yml` on `qvac-ubuntu2204-x64-gpu` (Linux x64 prebuilds verified present; reuses the desktop model cache). It mirrors the SDK suite's gating (`on-pr-test-sdk.yml`): `pull_request_target` for registry access, guarded by `label-gate` (`verified`) + `authorize-pr` (`safe-to-test`), and runs when the `test-e2e-full` label is applied (bare-sdk rides along with the SDK full suite rather than keeping its own smoke/full split), on a release-branch PR, or via manual `workflow_dispatch`. The job checks out PR head, builds the sibling sdk, installs the addon prebuilds with `--no-save`, and runs `test:bare:e2e`.
