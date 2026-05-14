# QVAC SDK v0.10.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.10.2

This is a hotfix release that restores delegated-inference connection performance to the level it was at in v0.9.0. No API or model changes — drop-in replacement for v0.10.1.

## Bug Fixes

### Delegated connect no longer waits for full DHT bootstrap

Consumers using `loadModel({ delegate: true, ... })` against a remote provider were spending ~2.5–3s longer per connection in v0.10.0/0.10.1 than in v0.9.0. Profiler traces from the Workbench team showed `loadModel.delegation.connection` regressing from ~2.5s (v0.9.0) to ~8.3s (v0.10.0) on the same machine and network.

The cause was a serial `await swarm.dht.fullyBootstrapped()` call that was added to the consumer's connect path in the v0.10.0 redesign. `dht.fullyBootstrapped()` only resolves once Hyperdht has populated its full routing table, which is a slow process from a cold swarm — and on a hot swarm `dht.connect(publicKey)` already drives the lookups it needs internally, so the explicit wait is redundant. Removing it lets the connection use the DHT in whatever state it's in at call time, exactly the way it did in v0.9.0.

The DHT routing table is still populated lazily as `dht.connect()` issues lookups, so cold-swarm correctness is unchanged — `PEER_NOT_FOUND` for non-existent peers and connection timeouts for unreachable ones both still fire on the same code path. The fallback-to-local behaviour for `loadModel` is unaffected; only the hot-path latency improves.

Local benchmarks (10 consumer↔provider runs each, against the published v0.10.1 baseline):

| Build              | Mean connection time | p50    | p95    |
| ------------------ | -------------------- | ------ | ------ |
| v0.10.1 (baseline) | 3.82s                | 3.71s  | 4.94s  |
| v0.10.2 (this fix) | 1.18s                | 1.12s  | 1.49s  |

That's ~3.2× faster on average and brings cold delegated `loadModel` back below the v0.9.0 numbers.

If you were on v0.10.0 or v0.10.1 and had pinned around the regression (custom timeouts, retry shims, falling back to local inference earlier than necessary), you can drop those workarounds.
