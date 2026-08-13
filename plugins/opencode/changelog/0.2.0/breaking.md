# 💥 Breaking Changes v0.2.0

## Harden serve CORS and managed authentication

PR: [#3744](https://github.com/tetherto/qvac/pull/3744)

_No migration code — the handshake is private to the plugin and the host it bundles._

- The private host handshake now carries a per-session `proxyToken` instead of the managed serve's own API key. The host authenticates proxy requests with that token and applies the serve credential itself, so the key never leaves the host process.
- A plugin and a host from different releases cannot hand off to each other, so upgrade them together — installing this package does that.

---
