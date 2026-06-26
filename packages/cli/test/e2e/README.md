# CLI end-to-end tests (`node:test`)

End-to-end tests for `@qvac/cli`, run with the Node built-in test runner via `tsx`.
They cover the CLI commands and the served HTTP API — both in-process (Fastify
`app.inject`) and as a black-box spawned binary.

## Run

```bash
npm run test:e2e:js            # full suite (serial — see Concurrency)
npm run test:e2e:js:coverage   # + node:test built-in coverage, scoped to src/
```

`dist` must be built first for the spawned-binary tests (`npm run build`). CI's
build step handles this; the test scripts don't re-build.

## Two ways to drive the CLI — and when to use each

### 1. In-process, via Fastify `app.inject()` — **default for `/v1/*` routes**

Helpers: `helpers/server.ts` (`createServer`, `useServer`, `useModelServer`).
Builds the _same_ server code `qvac serve openai` runs (`buildServer`) and injects
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
  http/               /v1/* route tests, in-process & modelless
    *-validation.test.ts, models, routing-cors-auth, audio-*
  cli/                commands, serve lifecycle & flag behavior (spawned binary)
  model/              everything that loads a real model — runs serially (see below)
    real-model.test.ts            in-process: LLM / embed / whisper
    model-lifecycle.test.ts       in-process: model unload
    streaming-transport.test.ts   spawned server: real-socket streaming + cancel
    tts.test.ts                   spawned config: TTS; encoded formats ffmpeg-gated
```

## Concurrency

Test files run in parallel by default (node:test spawns a process per file). The
modelless validation, command, and spawned-binary tests have no shared state —
each builds its own in-process server or spawns its own process on a free port in
its own temp dir — so they run in parallel, as the first pass of `test:e2e:js`.

The model-loading files (`model/`) run as a second, serial pass
(`--test-concurrency=1`) as a precaution. Run in parallel they _may_ contend on
the shared model cache in `~/.qvac` (cold on every CI run) or load several models

- SDK workers at once; neither has been shown to actually break, so they're
  serialized rather than risk flaky CI. If parallel model loads turn out to be
  safe, the two passes can be merged into one.

Within a file, node:test runs tests in definition order, but no test depends on
another's side effects — the destructive model-unload test has its own server, as
does the files empty-list check — so any file can also be run on its own.

`test:e2e:js:coverage` runs the whole suite in a single serial pass so the
built-in coverage report aggregates across every file.

## ffmpeg

The TTS encoded formats (mp3/opus/aac/flac) shell out to ffmpeg/ffprobe, so those
tests **auto-skip** where ffmpeg isn't on PATH (CI) and run where it is (local).
Native TTS (discovery, wav, pcm) always runs.

## Coverage

`test:e2e:js:coverage` uses node:test's built-in `--experimental-test-coverage`
(no external dependency), scoped to `src/`. It reports the **in-process** surface
(serve routes/adapters/plugins ≈ 80%+). Coverage of the spawned commands
(`verify`/`bundle`/`doctor`/`openai`) is _not_ folded into that number — built-in
coverage doesn't remap a child process's `dist` execution back to `src`. That's an
accepted trade-off for keeping zero coverage deps.

## Adding a test

- Asserting `/v1/*` behavior → in-process (`useServer` modelless, or `useModelServer`
  if it needs inference). Reuse `assertError`, `multipart`, `collectSSE`, fixtures.
- Exercising a command, an exit code, a real socket, or streaming-over-the-wire →
  spawned (`runCli` / `startCliServer` / `useSpawnedServer`).
- If it loads a model, put it under `model/` so it runs in the serial pass.
