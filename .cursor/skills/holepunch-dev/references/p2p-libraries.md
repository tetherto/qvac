# P2P Stack Library Catalog

Core Holepunch P2P libraries. All repos: https://github.com/holepunchto

## Networking

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| hyperswarm | hyperswarm | High-level API for finding and connecting to peers by topic | `new Hyperswarm()`, `swarm.join(discoveryKey)`, `swarm.on('connection', ...)` |
| hyperdht | hyperdht | DHT powering Hyperswarm; key → ip+port resolution | `new DHT()`, `dht.announce()`, `dht.lookup()` |

## Core Data

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| hypercore | hypercore | Secure, distributed append-only log; base for all higher structures | `new Hypercore()`, `core.append()`, `core.get()` |
| corestore | corestore | Hypercore factory; manages multiple interlinked Hypercores | `new Corestore()`, `store.get()`, `store.replicate()` |

## Data Structures

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| hyperbee | hyperbee | Append-only B-tree on Hypercore; sorted iteration | `new Hyperbee()`, `db.put()`, `db.get()`, `db.createReadStream()` |
| hyperdb | hyperdb | Schema-based database with multi-index support; materialized views | `HyperDB.bee()`, `view.insert()`, `view.find()`, `view.findOne()` |
| hyperschema | hyperschema | Declarative compact-encoding schemas | `Hyperschema.from()`, `ns.register()`, `Hyperschema.toDisk()` |
| hyperdispatch | hyperdispatch | Operation routing and dispatch for HyperDB | `Hyperdispatch.from()`, `routes.register()`, `Router`, `encode()`, `decode()` |

## File Management

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| hyperdrive | hyperdrive | Secure, real-time distributed P2P file system | `new Hyperdrive()`, `drive.replicate()`, `drive.promises.readFile()` |
| localdrive | localdrive | Local file system interoperable with Hyperdrive | `new Localdrive()` |
| mirror-drive | mirror-drive | Mirror between Hyperdrive and/or Localdrive | `new MirrorDrive()` |

## Multi-writer

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| autobase | autobase | Virtual Hypercore over many Hypercores; multi-writer causal ordering | `new Autobase()`, `base.append()`, `base.view`, `base.replicate()` |

## Pairing

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| blind-pairing | blind-pairing | Secure peer discovery via invite codes; member/candidate flow | `new BlindPairing()`, `addMember()`, `addCandidate()` |
| blind-peering | blind-peering | Read-only mirror synchronization | `new BlindPeering()`, `addAutobaseBackground()` |

## Connection Layer

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| protomux | protomux | Multiplex multiple message-oriented protocols over a stream | `new Protomux()`, `mux.createChannel()` |
| protomux-rpc | protomux-rpc | RPC over Protomux | `new ProtomuxRPC()`, `rpc.respond()` |
| @hyperswarm/secret-stream | hyperswarm-secret-stream | E2E encrypted connections between Hyperswarm peers | `SecretStream` |

## Encoding & Utilities

| Package | Repo | Description | Key API |
|---------|------|-------------|---------|
| compact-encoding | compact-encoding | Binary encoding schemes for parser-serializers | Various encoders |
| b4a | b4a | Buffer-to-anything; cross-runtime Buffer compat | `b4a.from()`, `b4a.equals()`, `b4a.toString()` |
| ready-resource | ready-resource | Resource lifecycle; open/close pattern | `extends ReadyResource`, `_open()`, `_close()` |
| safety-catch | safety-catch | Safe promise rejection handling | |
| protomux-wakeup | protomux-wakeup | Efficient peer coordination for Autobase | `wakeup` option in Autobase |

## Stability

All listed libraries are **stable** per docs.pears.com unless noted. Check repo README for current status.
