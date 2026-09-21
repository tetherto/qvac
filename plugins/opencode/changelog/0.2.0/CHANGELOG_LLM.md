# QVAC OpenCode Plugin v0.2.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.2.0

The managed serve the plugin starts is now authenticated, and the host that proxies to it has been hardened. Requests are pinned to a loopback upstream, hop-by-hop headers are no longer relayed, and a managed serve that fails to start now returns an error instead of leaving requests waiting.

## Breaking Changes

### The host handshake carries a session token, not the serve key

The private handshake between the plugin and its managed serve host now passes a per-session `proxyToken` instead of the managed serve's own API key. The host authenticates incoming proxy requests with that token and applies the real serve credential itself, so the serve key never leaves the host process.

This is internal to the plugin and its bundled host; no configuration changes. A plugin and a host from different releases cannot hand off to each other, so upgrade them together — which a normal `npm install` of this package does.

## Reliability

### A failed managed startup fails the request

If the managed provider cannot start — for example because the resolved provider is too old to expose the serve credential — proxied requests used to wait indefinitely on a readiness promise that would never settle. They now reject with a `503` naming the cause. Stopping the host while a startup is still in flight releases anything queued behind it rather than dropping the connections silently.

A host that exits after a successful handshake also now writes a line to stderr saying the `qvac` provider is gone and that OpenCode needs restarting, instead of failing quietly on the next request.

## Security

### The proxy will only talk to a loopback upstream

The host verifies that the managed serve it was handed is on a loopback address before forwarding anything to it, and refuses with an `UntrustedUpstreamError` otherwise. Hop-by-hop headers such as `proxy-connection` and `proxy-authorization` are stripped from forwarded requests, and `content-length` is always recomputed rather than copied from the incoming request.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.6.0` for managed mode, which generates and enforces the serve API key
- `@qvac/cli@^0.11.0` for `qvac serve` (SDK 0.17 runtime), the first CLI that accepts `--api-key-file` and so keeps the bearer key out of the process command line
