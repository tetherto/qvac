# 💥 Breaking Changes v0.11.0

## Harden serve CORS and managed authentication

PR: [#3744](https://github.com/tetherto/qvac/pull/3744)

**BEFORE:**

```typescript
// --cors enabled wildcard browser access; --docs inherited it.
qvac serve openai --cors --docs

// A non-loopback bind logged a warning and started anyway.
qvac serve openai --host 0.0.0.0

// Managed callers could pass an apiKey option that was not enforced by serve.
await createQvac({ managed: { models: ["qwen3-0.6b"], apiKey: "local-key" } })
```

**AFTER:**

```typescript
// Name every trusted browser origin. --docs adds same-port loopback origins only.
qvac serve openai --cors --cors-origin https://app.example.com

// A non-loopback bind must authenticate, or say out loud that it will not.
qvac serve openai --host 0.0.0.0 --api-key-file ~/.qvac/serve-key
qvac serve openai --host 0.0.0.0 --allow-unauthenticated

// Managed mode generates the enforced key; consumers may read the live value.
const provider = await createQvac({ managed: { models: ["qwen3-0.6b"] } })
provider.apiKey
```

- `--cors` now fails startup without `--cors-origin` or `serve.cors.origins`; `*` is rejected, as is an origin ending in a trailing dot.
- `--docs` no longer enables wildcard CORS and rejects `--port 0`.
- A non-loopback `--host` now fails startup unless `--api-key` or `--api-key-file` is given. `--allow-unauthenticated` restores the previous warn-and-start behaviour.
- `--api-key-file <path>` is added as the recommended alternative to `--api-key`, which leaves the credential in the process command line.
- `QvacManagedOptions.apiKey` is removed. `ManagedQvacProvider.apiKey` is the generated live credential.
- Existing OpenClaw installations must rerun `openclaw onboard --auth-choice qvac` to materialize the private key file and SecretRef. A key file that is not a regular file, or that is readable beyond its owner, now stops the launcher.
- The private OpenCode host handshake now carries a per-session `proxyToken` instead of the managed serve key.

---
