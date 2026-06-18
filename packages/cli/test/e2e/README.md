# CLI end-to-end tests (`node:test`)

End-to-end tests for `@qvac/cli`, run with the Node built-in test runner via `tsx`.
This suite is the JS counterpart to the BATS suites (`test/cli.bats`, `test/e2e.bats`,
`test/e2e-local.bats`); it reproduces their coverage and adds more. During the
migration both run side-by-side in CI; BATS is removed once parity holds.

## Run

```bash
npm run test:e2e:js            # full suite (serial — see Concurrency)
npm run test:e2e:js:coverage   # + node:test built-in coverage, scoped to src/
```

`dist` must be built first for the spawned-binary tests (`npm run build`). CI's
build step handles this; the scripts deliberately don't re-build (no redundant
build prefixes).

## Two ways to drive the CLI — and when to use each

### 1. In-process, via Fastify `app.inject()` — **default for `/v1/*` routes**

Helpers: `helpers/server.ts` (`createServer`, `useServer`, `useModelServer`).
Builds the *same* server code `qvac serve openai` runs (`buildServer`) and injects
requests without opening a socket. Fast, deterministic, no port.

Use for HTTP API behavior: routing, request/response shape, validation + error
codes, auth, CORS, multipart, and SSE bodies (light-my-request captures the
hijacked `reply.raw` SSE writes, including `[DONE]`).

- `useServer(opts)` — one modelless server per `describe` (validation paths;
  `preload:false`, so no model is loaded). Variants via opts: `cors`, `apiKey`,
  `publicBaseUrl`.
- `useModelServer(config)` — builds + `app.ready()` + `preloadModels` (no
  `listen`), for real-model happy paths. Loads models over P2P from the registry
  (no tokens). One shared server per file.

### 2. Spawned real binary, via `helpers/cli.ts` — for commands, lifecycle, transport fidelity

Spawns `node dist/index.js` (= `npx qvac`). Use when `app.inject` can't reach it:

- **CLI commands** (`runCli`): `version`/`help`, `verify deps`, `verify bundle`,
  `bundle sdk`, `doctor`, `openai spec` — assert stdout/stderr/exit code.
- **Serve lifecycle** (`startCliServer`): the built binary actually binds a port,
  serves over a real socket, logs its startup banner, shuts down on SIGTERM.
- **Real-socket streaming fidelity** (`useSpawnedServer`): SSE chunks delivered
  over the wire and a client hang-up mid-stream (the cancel-bridge) — neither is
  observable through `app.inject`.

Run commands the way a user does — in a real project where `@qvac/sdk` resolves
from `node_modules`; don't pass internal flags like `--sdk-path` (see
`bundle-verify.test.ts`).

## Layout

```
test/e2e/
  helpers/            config · server (in-process) · cli (spawned) · http · fixtures
  smoke.test.ts       harness smoke
  helpers.test.ts     harness self-tests (incl. SSE-via-inject)
  http/               /v1/* route tests
    *-validation.test.ts, models, routing-cors-auth, audio-*   in-process, modelless
    real-model.test.ts        in-process, loads LLM/embed/whisper
    streaming-transport.test.ts  spawned server, real-socket streaming + cancel
  tts.test.ts         spawned-config TTS (loads the TTS model); encoded formats ffmpeg-gated
  cli/                commands + lifecycle (spawned binary)
```

## Concurrency — why the suite runs serially

The scripts pass `--test-concurrency=1`, so test **files** run one at a time
(node:test otherwise runs files in parallel processes). This mirrors BATS's serial
execution and is required because three files load real models:

- `http/real-model.test.ts`, `tts.test.ts`, `http/streaming-transport.test.ts`.

Running those concurrently risks (a) **model-cache races** — two files downloading
the same blob into `~/.qvac/models` at once (cold cache, e.g. every CI run), and
(b) **memory pressure** from several models + SDK Bare workers loaded at once.

Everything else — the modelless in-process route tests and the no-model spawned
command tests — is parallel-safe. If suite wall-time ever becomes a problem, split
into two runs (default-concurrency for the parallel-safe files, `--test-concurrency=1`
for the model files), or pre-warm the model cache before a parallel run. Until then,
global serial keeps it simple and safe.

## ffmpeg

The TTS encoded formats (mp3/opus/aac/flac) shell out to ffmpeg/ffprobe, so those
tests **auto-skip** where ffmpeg isn't on PATH (CI) and run where it is (local).
Native TTS (discovery, wav, pcm) always runs.

## Coverage

`test:e2e:js:coverage` uses node:test's built-in `--experimental-test-coverage`
(no external dependency), scoped to `src/`. It reports the **in-process** surface
(serve routes/adapters/plugins ≈ 80%+). Coverage of the spawned commands
(`verify`/`bundle`/`doctor`/`openai`) is *not* folded into that number — built-in
coverage doesn't remap a child process's `dist` execution back to `src`. That's an
accepted trade-off for keeping zero coverage deps.

## Adding a test

- Asserting `/v1/*` behavior → in-process (`useServer` modelless, or `useModelServer`
  if it needs inference). Reuse `assertError`, `multipart`, `collectSSE`, fixtures.
- Exercising a command, an exit code, a real socket, or streaming-over-the-wire →
  spawned (`runCli` / `startCliServer` / `useSpawnedServer`).
- If it loads a model, it's bound by the serial requirement above.
