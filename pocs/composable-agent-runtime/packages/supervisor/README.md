# @qvac/supervisor

Minimal Elixir-light supervisor: the app declares what runs, whether each child can be rebooted, and which deaths trigger which reboots.

## Installation

```
npm i @qvac/supervisor
```

## Usage

```js
const Supervisor = require('@qvac/supervisor')

const sup = new Supervisor()

sup.add('core', { start: () => new Core(() => ipc, opts) })

sup.add('harness', {
  start({ onDeath }) {
    const harness = spawnHarness({ entry, skillsDir })
    harness.on('status', (s) => {
      if (s.state === 'died') onDeath(new Error(s.error ?? 'harness died'))
    })
    return harness
  }
})

sup.add('runner', {
  deps: ['core', 'harness'],
  start: ({ get }) => new Runner(get('core'), get('harness')),
  suspend: (runner) => runner.suspend(),
  resume: (runner) => runner.resume()
})

await sup.ready() // boots in dependency order

sup.on('gave-up', ({ name, error }) => console.error(name, 'is down for good:', error))

await sup.close() // tears down in reverse start order
```

Handles follow the `ready-resource` convention: if the returned handle has `ready()` the supervisor awaits it before the child counts as running, and if the spec has no `stop` the supervisor calls `handle.close()`. Handles without either (like a lazily-opening `RemoteHarness`) just skip those steps. Death is never inferred — only `ctx.onDeath` reports it, because every teardown signal in the wild also fires on deliberate close.

When `harness` dies, the supervisor stops its dependents (reverse start order), respawns `harness` after `backoff`, then restarts the dependents — each dependent's `start()` re-runs and `get('harness')` hands it the fresh handle. Re-construction is the handoff: no proxies, no handle swapping.

## Stow children

`@qvac/supervisor/stow` wraps a [bare-stow](https://github.com/holepunchto/bare-stow) worker as a spec: it launches the bundle, races ready against early exit, reports an exit as death automatically, and stops by destroying the ipc — the child EOF-exits per the stow contract, and `stop` resolves only after the real exit. Never a kill.

The host injects the runner explicitly: `runner/sidecar` for an OS process, or
`runner/relay` plus `host/spawner` when a mobile host owns child creation. The
same bundle and `start(ipc, ready)` entry contract runs through either adapter.
Worklets provide runtime separation but still share the host process, so a
native crash is not contained.

```js
const stowChild = require('@qvac/supervisor/stow')
const sidecarRunner = require('@qvac/supervisor/runner/sidecar')

sup.add(
  'media',
  stowChild(bundlePath, {
    runner: sidecarRunner,
    args: [storagePath],
    backoff: 500,
    create: (ipc) => new MediaClient(() => ipc) // optional; default handle is the ipc stream
  })
)
```

## Nesting

A `Supervisor` is itself a supervisable handle (it has `ready()`/`close()`), so a component ships its own subtree and a host supervises it as one child — deaths recover inside the subtree, and only exhaustion escalates:

```js
sup.add('assistant', {
  deps: ['core'],
  start({ get, onDeath }) {
    const tree = assistantTree({ core: get('core'), harness: buildHarness })
    tree.on('gave-up', ({ error }) => onDeath(error))
    return tree
  },
  suspend: (tree) => tree.suspend(),
  resume: (tree) => tree.resume()
})
```

## API

#### `const sup = new Supervisor([options])`

Options: `stallTimeout` (ms, default `5000`) — a child `stop()` exceeding it emits `'stall'`; the supervisor keeps waiting, it never kills.

#### `sup.add(name, spec)`

Declare a child. Call before `ready()`. Spec:

- `start(ctx)` — build the child, return its handle. If the handle has `ready()` it is awaited. `ctx.get(name)` resolves a declared dep's current handle. `ctx.onDeath([error])` reports this incarnation's death; calls from a stale incarnation or during deliberate teardown are ignored.
- `stop(handle)` — release the child (awaited; optional — defaults to `handle.close()` when present).
- `suspend(handle)` / `resume(handle)` — opt-in lifecycle hooks (optional).
- `deps` — names this child needs; boot order is topological, teardown is reverse start order, and a dep's death stops and later restarts this child.
- `restart` — `'always'` (default) or `'never'`.
- `maxRestarts` / `window` — restart intensity: more than `maxRestarts` deaths (default `3`) within `window` ms (default `30000`) gives up: the child goes `'failed'`, its dependents stay `'stopped'`, `'gave-up'` fires, the supervisor stays up.
- `backoff` — base restart delay in ms (default `1000`), doubling per death inside `window` and capped by `maxBackoff` (default `30000`).

#### `await sup.ready()`

Boots all children in dependency order. A `start()` throw during boot fails `ready()` — no restarts during boot.

#### `await sup.close()`

Stops all children in reverse start order. Idempotent, single-flight.

#### `sup.get(name)`

Current handle of a running child. Throws if the child isn't running.

#### `await sup.suspend([options])` / `await sup.resume()`

Calls `spec.suspend` on children that declare it in reverse start order; `spec.resume` in start order. `suspend({ linger })` waits `linger` ms before running the hooks — a `resume()` arriving inside the window coalesces the suspend entirely (no hooks fire, emits `'suspend-coalesced'`), the pattern mobile hosts use so a quick app-switch never tears anything down. Restarts park immediately either way and revive on resume.

#### `await sup.reload(name[, spec])`

Deliberate upgrade: stops the child's dependents (reverse order) and the child, swaps in `spec` — or a fresh one from the child's spec factory (`add` accepts `() => spec`) — then restarts everything. Not a death: no intensity accounting, and the new code gets a fresh budget; it is also the manual recovery path after `'gave-up'`. With a stow child this is hot code reload: replace the `.bundle` on disk and `reload(name)` — the respawned process runs the new code. A reload must not change the child's `deps`.

The Erlang mapping: `code_change` ≈ re-construction against durable storage (start fresh, re-open state), `appup` ≈ replace bundle + `reload(child)`, `relup` ≈ restart the whole app.

#### `sup.inspect()`

Live snapshot: `[{ name, state, lives, deps, error, uptime, deaths, info }]` — `state` is `idle | starting | running | stopping | stopped | failed`, `uptime` is ms since the current incarnation started (`null` when down), `deaths` counts recent deaths inside the intensity window, and `info` is whatever the spec's optional `inspect(handle)` returns for a running child (a synchronous, secrets-stay-out-by-construction state slice — e.g. a harness spec exposing its loaded models).

#### Events

`'child-ready' { name, lives }` · `'child-died' { name, error }` · `'child-restarting' { name, delay }` · `'child-stopped' { name }` · `'child-reloaded' { name }` · `'gave-up' { name, error }` · `'suspend-coalesced'` · `'stall' { name }`

## License

Apache-2.0
