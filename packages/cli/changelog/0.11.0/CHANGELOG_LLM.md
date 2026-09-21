# QVAC CLI v0.11.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.11.0

This release tightens the security posture of `qvac serve`. Browser access now requires an explicit list of trusted origins, a bind beyond loopback refuses to start without authentication, and the bearer key can be read from a file instead of the command line. Existing `--cors` and `--host` invocations will need updating.

## Breaking Changes

### Trusted browser origins must be named explicitly

`--cors` no longer opens the server to every origin. It is now only a compatibility validation switch: it does not enable CORS by itself, and it fails startup unless at least one exact origin is supplied through `--cors-origin` or `serve.cors.origins`. Wildcards are rejected, as are origins ending in a trailing dot, which no browser sends.

`--docs` no longer inherits wildcard access either. It adds same-port `localhost`, `127.0.0.1`, and `[::1]` origins for Swagger UI, and it rejects `--port 0`, because a same-port origin cannot be computed before the port is known.

**Before:**

```bash
qvac serve openai --cors --docs
```

**After:**

```bash
qvac serve openai --cors --cors-origin https://app.example.com
```

### A non-loopback bind must authenticate

Binding beyond `127.0.0.1` used to log a warning and start anyway, which quietly exposed an unauthenticated API to the network. It now fails startup unless a key is supplied, or unless the operator says outright that the exposure is intended.

**Before:**

```bash
# Warned, then served the whole network with no authentication.
qvac serve openai --host 0.0.0.0
```

**After:**

```bash
# Require a bearer token...
qvac serve openai --host 0.0.0.0 --api-key-file ~/.qvac/serve-key

# ...or accept the risk explicitly, which warns and starts as before.
qvac serve openai --host 0.0.0.0 --allow-unauthenticated
```

## New Flags

### `--api-key-file` keeps the credential out of the process list

`--api-key <key>` places the token in the process's command line, which `/proc/<pid>/cmdline` exposes to every local account on Linux. `--api-key-file <path>` reads it from a file instead:

```bash
printf '%s' "$QVAC_API_KEY" > ~/.qvac/serve-key
chmod 600 ~/.qvac/serve-key
qvac serve openai --api-key-file ~/.qvac/serve-key
```

The path must be a regular file — symlinks and directories are refused — and the CLI warns when the file is readable beyond its owner. `--api-key` and `--api-key-file` are mutually exclusive.

### `--allow-unauthenticated` opts back into an open bind

For operators who genuinely want an unauthenticated listener beyond loopback, this restores the previous warn-and-start behaviour. Anyone who can reach the address can use the server.
