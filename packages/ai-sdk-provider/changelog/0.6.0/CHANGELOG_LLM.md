# QVAC AI SDK Provider v0.6.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.6.0

Managed mode now authenticates. The provider generates a random API key for every serve it starts, enforces it on outgoing requests, and keeps it out of the process command line. Callers no longer supply a managed key — they read the live one from the provider when they need it.

## Breaking Changes

### Managed mode owns the API key

`QvacManagedOptions.apiKey` is gone. Passing a key was misleading: the previous `qvac serve` did not validate it, so the option gave the appearance of authentication without any. Managed mode now generates a cryptographically random key per serve fleet, stores it in the private managed registry record, and reuses that record's key when attaching to an existing fleet.

Because the provider owns the credential, a caller-supplied `authorization` header on a managed provider is replaced with the resolved managed key. Custom `fetch` wrappers still run, but they receive requests that are already authorized — treat the `Authorization` header they see as secret material and keep it out of logs.

**Before:**

```ts
const qvac = await createQvac({
  mode: 'managed',
  models: ['QWEN3_8B_INST_Q4_K_M'],
  apiKey: 'local-key'
})
```

**After:**

```ts
const qvac = await createQvac({
  mode: 'managed',
  models: ['QWEN3_8B_INST_Q4_K_M']
})
```

### External mode keys are now enforced by serve

In external mode the provider's default `apiKey` is still the literal string `'qvac'`, but `qvac serve` no longer ignores it. If the server was started with `--api-key` or `--api-key-file`, the value passed to `createQvac` must match it, or requests are rejected with a 401.

## New APIs

### `provider.apiKey` exposes the live managed credential

Trusted in-process adapters that need to reach the managed serve outside the provider's own `fetch` can read the key it is currently using:

```ts
await using qvac = await createQvac({ mode: 'managed', models: ['QWEN3_8B_INST_Q4_K_M'] })

// Read it fresh per request: crash recovery respawns the serve with a new key.
const res = await fetch(`${qvac.baseURL}/models`, {
  headers: { authorization: `Bearer ${qvac.apiKey}` }
})
```

The property is deliberately non-enumerable, so `{ ...provider }`, `Object.keys(provider)`, and casual object dumps never carry it. Never log it or hand it to an untrusted process.

## Security

### The key never appears in a process argument list

Neither the detached runner nor the `qvac serve` process it starts receives the key through argv. Both read it from a one-shot owner-only (`0600`) file, so it cannot be recovered from `ps` or `/proc/<pid>/cmdline`, which on Linux is readable by every local account.

Passing the key on the serve command line now only happens against a CLI too old for `--api-key-file`, which the provider detects and falls back to, or behind a `serveBinPath` override, whose version cannot be determined. Install `@qvac/cli` 0.11.0 or newer to keep the key out of the process list in every case.

### Serves from before managed authentication are reaped

The registry sweep that runs at the start of every `createQvac` now also cleans up after older provider versions. A record carrying no key belongs to a serve that is listening without authentication, so the sweep probes it anonymously and shuts it down rather than leaving it running. Abandoned one-shot runner handoff files are removed once no runner could still be waiting to read one.

## Compatibility

The `@qvac/cli` peer range widens to `^0.10.0 || ^0.11.0`. Both work; 0.11.0 is what enables the file-based credential described above.
