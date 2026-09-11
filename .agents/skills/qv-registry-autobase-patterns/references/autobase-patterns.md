# Autobase + HyperDB Multi-Writer Architecture

## Overview

Multi-writer distributed database using Autobase with HyperDB view layer, event sourcing patterns, and peer discovery.

**Reference Priority:**
1. **Primary**: Comprehensive multi-writer patterns, deployment procedures, RPC setup (see references in the `registry-autobase-patterns` skill)
2. **Secondary**: Blind pairing/peering implementation details (inline below)

## Core Architecture

### 1. Autobase Configuration

**Registry implementation** (from `registry-service.js`):
```javascript
this.base = new Autobase(this.store, this.autobaseBootstrap, {
  open: this._openAutobase.bind(this),
  apply: this._apply.bind(this),
  close: this._closeAutobase.bind(this),
  ackInterval: this.ackInterval,
  ackThreshold: this.ackThreshold
})
```

The `open` callback returns a `RegistryDatabase` (a HyperDB wrapper from `@qvac/registry-schema`):
```javascript
_openAutobase (store) {
  const dbCore = store.get('db-view')
  return new RegistryDatabase(dbCore, { extension: false })
}
```

**Key points:**
- `open` returns the view instance (here a `RegistryDatabase` wrapping HyperDB)
- `apply` processes append-only log entries into the materialized view
- `ackInterval`/`ackThreshold` control indexer acknowledgment timing
- `close` callback handles view teardown

> **Generic pattern (from Autobase workshops):** Other Autobase apps may use `encrypt: true` with `encryptionKey` and a `wakeup` option — the registry does not use these.

### 2. Router-Based Apply Function

**Registry implementation:**
```javascript
async _apply (nodes, view, base) {
  if (!view.opened) await view.ready()

  for (const node of nodes) {
    await this.applyRouter.dispatch(node.value, { view, base })
  }

  await view.db.flush()
}
```

**Pattern:**
- Iterate through nodes from autobase
- Dispatch encoded operations to handlers via the Hyperdispatch `Router`
- Router decodes and routes to registered handler
- Flush view after batch processing

### 3. Router Setup with Hyperdispatch

**Registry implementation:**
```javascript
this.applyRouter = new Router()

this.applyRouter.add('@qvac-registry/put-model', async (model, context) => {
  await context.view.putModel(model)
})

this.applyRouter.add('@qvac-registry/add-indexer', async ({ key }, context) => {
  await context.base.addWriter(key, { indexer: true })
})
```

**Context object:**
- `context.view` - The RegistryDatabase (HyperDB) instance for queries/mutations
- `context.base` - Autobase instance for writer/indexer management

### 4. Blind Pairing Pattern (Generic / Workshop Reference)

> **Note:** The registry server does **not** use blind pairing. It uses **blind peering** (section 5) for read-only mirror synchronization. This section is included as a generic Autobase pattern reference from Holepunch workshops.

**Creator (inviter):**
```javascript
const inv = await pass.createInvite()
console.log('Share this:', inv) // z32-encoded

this.pairing = new BlindPairing(this.swarm)
this.member = this.pairing.addMember({
  discoveryKey: this.base.discoveryKey,
  onadd: async (candidate) => {
    const inv = await this.base.view.findOne('@namespace/invite', {})
    if (inv && b4a.equals(inv.id, candidate.inviteId)) {
      candidate.open(inv.publicKey)
      await this.addWriter(candidate.userData)
      candidate.confirm({ key: this.base.key, encryptionKey: this.base.encryptionKey })
      await this.deleteInvite()
    }
  }
})
```

**Joiner (candidate):**
```javascript
this.pairing = new BlindPairing(this.swarm)
const core = Autobase.getLocalCore(this.store)
await core.ready()

this.candidate = this.pairing.addCandidate({
  invite: z32.decode(inviteString),
  userData: core.key,
  onadd: async (result) => {
    this.pass = new Autopass(this.store, {
      swarm: this.swarm,
      key: result.key,
      encryptionKey: result.encryptionKey,
      wakeup: this.wakeup
    })
  }
})
```

### 5. Blind Peering (Mirrors)

For read-only mirrors that sync without write access. **This is what the registry uses.**

**Registry implementation** (from `_setupBlindPeering`):
```javascript
this.blindPeering = new BlindPeering(this.swarm, this.store, {
  mirrors: this.blindPeerKeys
})

await this.blindPeering.addAutobase(this.base)
await this.blindPeering.addCore(this.view.core, this.view.core.key, { announce: true })
```

## Schema Build Pipeline

Generated specs live under `shared/spec/` in the registry server package. Run `npm run build:spec` (which executes `scripts/build-db-spec.js`) to regenerate after schema changes.

### Step 1: Define Schema

```javascript
const SCHEMA_DIR = path.join(__dirname, '..', 'shared', 'spec', 'hyperschema')

const schema = Hyperschema.from(SCHEMA_DIR)
const ns = schema.namespace('myapp')

ns.register({
  name: 'record',
  compact: false,
  fields: [
    { name: 'key', type: 'string', required: true },
    { name: 'value', type: 'string', required: false }
  ]
})

Hyperschema.toDisk(schema)
```

### Step 2: Define Collections

```javascript
const SCHEMA_DIR = path.join(__dirname, '..', 'shared', 'spec', 'hyperschema')
const DB_DIR = path.join(__dirname, '..', 'shared', 'spec', 'hyperdb')

const dbTemplate = HyperDBBuilder.from(SCHEMA_DIR, DB_DIR)
const collections = dbTemplate.namespace('myapp')

collections.register({
  name: 'records',
  schema: '@myapp/record',
  key: ['key']
})

HyperDBBuilder.toDisk(dbTemplate)
```

### Step 3: Define Dispatch Routes

```javascript
const DISPATCH_DIR = path.join(__dirname, '..', 'shared', 'spec', 'hyperdispatch')

const dispatch = Hyperdispatch.from(SCHEMA_DIR, DISPATCH_DIR)
const routes = dispatch.namespace('myapp')

routes.register({
  name: 'put',
  requestType: '@myapp/record'
})

routes.register({
  name: 'del',
  requestType: '@myapp/delete'
})

Hyperdispatch.toDisk(dispatch)
```

### Step 4: Use Compiled Specs

In the registry, compiled specs are published as the `@qvac/registry-schema` package (from `shared/`). The service imports them directly:

```javascript
const schema = require('@qvac/registry-schema')
const { Router, encode: encodeDispatch } = schema.hyperdispatchSpec
const RegistryDatabase = schema.RegistryDatabase

// To append operations
await this.base.append(encodeDispatch('@qvac-registry/put-model', modelData))
```

## Common Operations

### Append Data

```javascript
async add(key, value) {
  await this.base.append(encode('@namespace/put', { key, value }))
}
```

### Query Data

```javascript
async get(key) {
  return await this.base.view.get('@namespace/records', { key })
}

list() {
  return this.base.view.find('@namespace/records', {})
}
```

### Writer Management

```javascript
async addWriter(key) {
  await this.base.append(encode('@namespace/add-writer', {
    key: b4a.isBuffer(key) ? key : b4a.from(key)
  }))
}

async removeWriter(key) {
  await this.base.append(encode('@namespace/remove-writer', {
    key: b4a.isBuffer(key) ? key : b4a.from(key)
  }))
}
```

## Hyperswarm Integration

**Registry implementation** (from `scripts/bin.js`):
```javascript
const keyPair = await store.createKeyPair('rpc-key')
const dht = new DHT({ keyPair })
const swarm = new Hyperswarm({ dht, keyPair })
```

**Named keypairs in the registry codebase:**
- `'rpc-key'` — Hyperswarm/DHT identity for the server
- `'writer-key'` — Client authentication keypair for add-model RPC

Connection handling (from `registry-service.js`):
```javascript
this.swarm.on('connection', (conn, peerInfo) => {
  this._setupRpc(conn)
  const replicationStream = this.store.replicate(conn)
  this.base.replicate(replicationStream)
})

this.swarm.join(this.base.discoveryKey, { server: true, client: true })
```

## Suspend/Resume Pattern (Generic)

> This is a generic Autobase pattern. The registry server does not currently implement suspend/resume.

```javascript
async suspend() {
  if (this.swarm) {
    await this.swarm.suspend()
    await this.store.suspend()
  }
}

async resume() {
  if (this.swarm) {
    await this.store.resume()
    await this.swarm.resume()
  }
}
```

## Key Dependencies

- `autobase` - Multi-writer append-only log with causal ordering
- `hyperdb` - Materialized view layer with collections and indexes
- `hyperschema` - Schema definition and encoding
- `hyperdispatch` - Operation routing and dispatch
- `blind-pairing` - Secure peer discovery via invite codes
- `blind-peering` - Read-only mirror synchronization
- `hyperswarm` - P2P networking and discovery
- `protomux-wakeup` - Efficient peer coordination
- `corestore` - Hypercore storage management (requires v7+)

## Important Notes

- **Corestore 7 required**: Uses RocksDB for atomicity
- **Flush after apply**: Call `await view.db.flush()` after batch operations (in the registry, `view` is a `RegistryDatabase` so flush is on `view.db`)
- **Update events**: Listen to `base.on('update', ...)` for changes
- **ackInterval/ackThreshold**: Registry uses these to control indexer acknowledgment timing (not `encrypt`/`wakeup`)
- **Bootstrap**: Optional autobase bootstrap key for joining existing autobases; optional DHT bootstrap for testnet isolation
- **Encryption**: Some Autobase apps use `encrypt: true` with `encryptionKey` — the registry does not

## Testing Pattern

```javascript
const testnet = require('hyperdht/testnet')
const tn = await testnet(10, t)

const pass = new MyApp(new Corestore(dir), {
  bootstrap: tn.bootstrap
})
```

## When to Use This Pattern

Use these Autobase + HyperDB patterns when you need:
- Multi-writer distributed database
- Secure peer discovery without central coordination
- Materialized view of append-only operations
- Encrypted multi-writer collaboration
- Read-only mirrors for data distribution
- Schema-based operation validation
- Type-safe operation dispatch

## References

For comprehensive Autobase multi-writer patterns, deployment procedures, RPC setup, and HyperDB learnings, use the `registry-autobase-patterns` skill.
