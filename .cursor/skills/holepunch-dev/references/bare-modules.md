# Bare Runtime Modules

Bare is a small, modular JavaScript runtime for desktop and mobile. Most bare-* modules are Node.js standard library equivalents with near-identical APIs. Use `bare-X` instead of Node.js built-ins when targeting Bare/Pear runtime.

## Node.js to Bare Mapping

| Node.js module | Bare equivalent | Notes |
|----------------|-----------------|-------|
| fs | bare-fs | Same API |
| crypto | bare-crypto | Same API (createHash, createHmac, etc.) |
| net | bare-tcp | Similar API (createServer, createConnection) |
| child_process | bare-subprocess | Similar API (spawn) |
| stream | bare-stream | Uses streamx |
| zlib | bare-zlib | Same API |
| path | bare-path | Same API |
| os | bare-os | Same API |
| url | bare-url | WHATWG URL |
| buffer | bare-buffer | Native buffers |
| dgram | bare-dgram | UDP |
| dns | bare-dns | Domain resolution |
| http | bare-http1 | HTTP/1 |
| https | bare-https | HTTPS |
| tls | bare-tls | TLS streams |
| tty | bare-tty | TTY streams |
| timers | bare-timers | setTimeout, setInterval |
| events | bare-events | EventEmitter |
| console | bare-console | WHATWG console |
| assert | bare-assert | Assertions |
| encoding | bare-encoding | WHATWG text encoding |
| intl | bare-intl | ECMAScript Intl API |
| fetch | bare-fetch | WHATWG Fetch |
| worker_threads | bare-worker | Worker threads |
| ws | bare-ws | WebSocket |

## Unique Bare Modules (no Node.js equivalent)

| Package | Description |
|---------|--------------|
| bare-rpc | RPC functionality; librpc ABI compatible |
| bare-sidecar | Start and manage Bare sidecar processes from Node.js/Electron |
| bare-prebuild | Build tooling |
| bare-daemon | Create and manage daemon processes |
| bare-inspector | V8 inspector support |
| bare-pack | Bundle packing |
| bare-unpack | Bundle unpacking |

## Usage

When writing code for Bare/Pear runtime, replace Node.js imports:

```javascript
// Node.js
const fs = require('fs')
const crypto = require('crypto')

// Bare
const fs = require('bare-fs')
const crypto = require('bare-crypto')
```

APIs are nearly identical; the main difference is the package source.
