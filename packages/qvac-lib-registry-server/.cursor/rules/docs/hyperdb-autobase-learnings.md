# HyperDB Autobase Multi-Writer Workshop Learnings

## Overview

This document builds on the single-writer HyperDB workshop by introducing Autobase for multi-writer capabilities, enabling production-ready services with high availability and safe backup strategies.

## Core Problem: Single-Writer Limitations

### Issues with Single-Writer Architecture

**No High Availability:**
- Single instance means single point of failure
- Service down when instance down
- No redundancy

**No Safe Backups:**
- **CRITICAL**: Never backup corestore folders directly
- Copying live corestore corrupts hypercore
- Traditional backup strategies don't work

**Solution: Autobase Multi-Writer**

With 3 writer instances:
- 1 writer down → service continues processing
- 2 writers down → service accepts requests (processed when writers return)
- 1 writer lost permanently → rotate out using remaining 2, add new writer

## Autobase Architecture

### Event Sourcing Pattern

Autobase uses event sourcing: writers append operations, Autobase linearizes into consistent view.

```
Writer 1 (Local Core) ──┐
                        │
Writer 2 (Local Core) ──┼──→ Autobase Linearizer ──→ View (HyperDB)
                        │     (Causal DAG)
Writer 3 (Local Core) ──┘
```

### Key Concepts

**Writers**: Each writer has local core with unique key  
**Operations**: Appended events that modify state  
**Linearization**: Autobase orders operations using causal DAG  
**View**: Derived state from applied operations  
**Indexers**: Writers that build and maintain the view  
**Eventual Consistency**: CAP theorem - prioritizes availability and partition tolerance

### View Key Stability

- View key changes when writers added/removed
- Indexed portion is stable
- Unindexed tip may change during reordering
- Use null append trick to stabilize initial view key

## New Tools Introduced

### Hyperdispatch

Schema-based operation definitions for Autobase.

**Purpose**: Type-safe operation encoding/decoding  
**Pattern**: Define operations with associated schemas  
**Benefit**: Maintainable operation handling

### Protomux RPC

RPC framework over Protomux channels.

**Server Side**: Define endpoints with `respond()`  
**Client Side**: Make requests with `request()`  
**Benefit**: Clean remote method invocation

### Protomux RPC Client

Connection management for RPC clients.

**Features**:
- Lazy connection opening
- Automatic reconnection
- Connection garbage collection
- Suspend/resume support

## Implementation Pattern

### 1. Schema Definition with Hyperdispatch

```javascript
// build.js
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')
const Hyperdispatch = require('hyperdispatch')

const SCHEMA_DIR = path.join(__dirname, 'spec', 'hyperschema')
const DB_DIR = path.join(__dirname, 'spec', 'hyperdb')
const DISPATCH_DIR = path.join(__dirname, 'spec', 'hyperdispatch')

function setupSchema() {
  const schema = Hyperschema.from(SCHEMA_DIR)
  const registry = schema.namespace('registry')

  // Data schema (same as before)
  registry.register({
    name: 'entry',
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'driveKey', type: 'fixed32', required: true },
      { name: 'type', type: 'string', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'owner', type: 'string', required: false }
    ]
  })

  // NEW: Operation schemas
  registry.register({
    name: 'writer',
    fields: [
      { name: 'key', type: 'buffer', required: true }
    ]
  })

  Hyperschema.toDisk(schema)
}

function setupDispatch() {
  const dispatch = Hyperdispatch.from(SCHEMA_DIR, DISPATCH_DIR)
  const namespace = dispatch.namespace('registry')

  // Define operations
  namespace.register({
    name: 'add-writer',
    requestType: '@registry/writer'
  })

  namespace.register({
    name: 'put-entry',
    requestType: '@registry/entry'
  })

  Hyperdispatch.toDisk(dispatch)
}
```

### 2. Autobase Service Implementation

```javascript
// index.js
const Autobase = require('autobase')
const ReadyResource = require('ready-resource')
const { Router, encode: dispatch } = require('./spec/hyperdispatch')

class RegistryService extends ReadyResource {
  constructor(store, swarm, { ackInterval, autobaseBootstrap = null } = {}) {
    super()
    
    this.store = store
    this.swarm = swarm

    // Setup operation router
    this.applyRouter = new Router()
    this.applyRouter.add(
      '@registry/add-writer',
      async (data, context) => {
        await context.base.addWriter(data.key, { indexer: true })
      }
    )
    this.applyRouter.add(
      '@registry/put-entry',
      async (entry, context) => {
        await context.view.put(entry)
      }
    )

    // Initialize Autobase
    this.base = new Autobase(this.store, autobaseBootstrap, {
      open: this._openAutobase.bind(this),
      apply: this._apply.bind(this),
      close: this._closeAutobase.bind(this),
      ackInterval
    })
  }

  get view() {
    return this.base.view
  }

  async _open() {
    await this.store.ready()
    await this.base.ready()
    await this.view.ready()

    // Setup RPC on connections
    this.swarm.on('connection', conn => {
      this._setupRpc(conn)
    })

    // Join autobase discovery
    this.swarm.join(this.base.discoveryKey, { server: true, client: true })

    // Stabilize view key on first run
    if (this.base.isIndexer) {
      if (!this.view.db.core.length) {
        await this.base.append(null)
      }
    }

    // Download full view
    this.view.db.core.download({ start: 0, end: -1 })
  }

  async _close() {
    this.swarm.leave(this.base.discoveryKey)
    await this.base.close()
  }

  _openAutobase(store) {
    const dbCore = store.get('db-view')
    return new Db(dbCore, { extension: false }) // CRITICAL: extension: false
  }

  async _closeAutobase(view) {
    await view.close()
  }

  // Apply handler - called by Autobase linearizer
  async _apply(nodes, view, base) {
    if (!view.opened) await view.ready()

    for (const node of nodes) {
      await this.applyRouter.dispatch(node.value, { view, base })
    }
  }

  // Public API methods
  async addWriter(key) {
    key = IdEnc.decode(key)
    await this.base.append(
      dispatch('@registry/add-writer', { key })
    )
  }

  async putEntry(entry) {
    await this.base.append(
      dispatch('@registry/put-entry', entry)
    )
  }
}
```

### 3. RPC Layer Setup

```javascript
// In RegistryService class
_setupRpc(conn) {
  const rpc = new ProtomuxRPC(conn, {
    id: this.swarm.keyPair.publicKey,
    valueEncoding: cenc.none
  })
  
  rpc.respond(
    'put-entry',
    { requestEncoding: EntryEnc, responseEncoding: cenc.none },
    async (entry) => {
      if (!this.opened) await this.ready()
      await this.putEntry(entry)
    }
  )
}
```

### 4. RPC Client Implementation

```javascript
// client.js
const { resolveStruct } = require('./spec/hyperschema')
const EntryEnc = resolveStruct('@registry/entry')
const cenc = require('compact-encoding')

class RegistryClient {
  constructor(registryKey, rpcClient) {
    this.registryKey = registryKey
    this.rpcClient = rpcClient
  }

  async putEntry(entry) {
    return await this.rpcClient.makeRequest(
      this.registryKey,
      'put-entry',
      entry,
      { requestEncoding: EntryEnc, responseEncoding: cenc.none }
    )
  }
}
```

### 5. CLI Implementation

```javascript
// bin.js
const { command, flag, arg } = require('paparam')

// Run server command
const runCmd = command('run',
  flag('--storage|-s [path]', 'storage path'),
  flag('--bootstrap|-b [bootstrap]', 'Bootstrap key for existing autobase'),
  async function ({ flags }) {
    const storage = path.resolve(flags.storage || DEFAULT_STORAGE)
    const autobaseBootstrap = flags.bootstrap 
      ? IdEnc.decode(flags.bootstrap) 
      : null

    const store = new Corestore(storage)
    const swarm = new Hyperswarm({
      keyPair: await store.createKeyPair('public-key')
    })
    
    swarm.on('connection', (conn) => store.replicate(conn))

    const service = new Registry(
      store.namespace(NAMESPACE), 
      swarm, 
      { autobaseBootstrap, ackInterval: 10 }
    )

    await service.ready()

    // Announce view for lookups
    swarm.join(service.view.discoveryKey)

    // Log status
    if (service.base.isIndexer) {
      logger.info('I am an indexer')
    } else {
      logger.warn('Not yet indexer. Add my local key as writer.')
      service.base.once('is-indexer', () => {
        logger.info('Became indexer')
      })
    }

    logger.info(`Local key: ${IdEnc.normalize(service.base.local.key)}`)
    logger.info(`Autobase key: ${IdEnc.normalize(service.base.key)}`)
    logger.info(`View key: ${IdEnc.normalize(service.view.publicKey)}`)
    logger.info(`RPC server key: ${IdEnc.normalize(service.serverPublicKey)}`)
  }
)

// Add writer admin command
const adminAddWriter = command('admin-add-writer',
  arg('<key>', 'key of writer to add'),
  flag('--storage|-s [path]', 'storage path'),
  async function ({ flags, args }) {
    const storage = path.resolve(flags.storage || DEFAULT_STORAGE)
    const key = IdEnc.decode(args.key)

    const store = new Corestore(storage)
    const swarm = new Hyperswarm()
    swarm.on('connection', (conn) => store.replicate(conn))

    const service = new Registry(
      store.namespace(NAMESPACE), 
      swarm, 
      { ackInterval: 10 }
    )

    await service.ready()
    
    logger.info(`Adding writer ${IdEnc.normalize(key)}`)
    await service.addWriter(key)
    logger.info('Successfully added writer. Wait for sync, then ctrl-c')
  }
)
```

## Deployment Procedure: 3-Writer Setup

### Initial Bootstrap

**Window 1 (Primary Writer):**
```bash
node bin.js run
```
Note the Autobase key from output.

**Window 2 (Second Instance):**
```bash
node bin.js run --storage store2 --bootstrap <autobase-key>
```
Note the Local key from output.

**Window 3 (Third Instance):**
```bash
node bin.js run --storage store3 --bootstrap <autobase-key>
```
Note the Local key from output.

### Add Second Writer

End Window 1 process, then:

```bash
node bin.js admin-add-writer <Window-2-Local-key>
```

Wait until Window 2 logs "I have become an indexer".

### Add Third Writer

End Window 1 process again, then:

```bash
node bin.js admin-add-writer <Window-3-Local-key>
```

Wait until Window 3 logs "I have become an indexer".

### Restart All Writers

End all processes, then restart:

```bash
# Window 1
node bin.js run

# Window 2
node bin.js run --storage store2 --bootstrap <autobase-key>

# Window 3
node bin.js run --storage store3 --bootstrap <autobase-key>
```

All three should report as indexers with stable view key.

## Critical Configuration Details

### Hyperbee Extension Disabled

```javascript
// CRITICAL: Autobase incompatible with Hyperbee extension
const db = HyperDB.bee(core, spec, { 
  extension: false,  // Must be false for Autobase
  autoUpdate: true 
})
```

### Ack Interval

```javascript
new Autobase(store, bootstrap, {
  ackInterval: 10  // Enable automatic acknowledgements (ms)
})
```

**Purpose**: Helps linearizer converge by eagerly appending null values to merge causal forks.

### View Key Stabilization

```javascript
if (this.base.isIndexer) {
  // Prevent view key change after first real entry
  if (!this.view.db.core.length) {
    await this.base.append(null)
  }
}
```

### Full View Download

```javascript
// Ensure all writers have complete view
this.view.db.core.download({ start: 0, end: -1 })
```

## Router Pattern with Hyperdispatch

### Setup Router

```javascript
const { Router, encode: dispatch } = require('./spec/hyperdispatch')

this.applyRouter = new Router()
```

### Register Handlers

```javascript
this.applyRouter.add(
  '@registry/operation-name',
  async (data, context) => {
    // data: decoded operation data
    // context: { view, base, ...custom }
    
    // Perform operation
    await context.view.someMethod(data)
  }
)
```

### Dispatch Operations

```javascript
// Encode and append to Autobase
await this.base.append(
  dispatch('@registry/operation-name', operationData)
)
```

### Apply Handler

```javascript
async _apply(nodes, view, base) {
  for (const node of nodes) {
    // Router automatically decodes and routes
    await this.applyRouter.dispatch(
      node.value, 
      { view, base, ...customContext }
    )
  }
}
```

## RPC Patterns

### Server Side (Protomux RPC)

```javascript
const ProtomuxRPC = require('protomux-rpc')

// On connection
const rpc = new ProtomuxRPC(conn, {
  id: this.swarm.keyPair.publicKey,  // Service identifier
  valueEncoding: cenc.none            // Default encoding
})

// Register endpoint
rpc.respond(
  'method-name',
  { 
    requestEncoding: MyRequestSchema, 
    responseEncoding: MyResponseSchema 
  },
  async (request) => {
    // Handle request
    return response
  }
)
```

### Client Side (Protomux RPC Client)

```javascript
const ProtomuxRpcClient = require('protomux-rpc-client')
const HyperDHT = require('hyperdht')

const dht = new HyperDHT()
const rpcClient = new ProtomuxRpcClient(dht, {
  backoffValues: [5000, 15000, 60000, 300000],
  requestTimeout: 10000,
  msGcInterval: 60000
})

// Make request
const response = await rpcClient.makeRequest(
  serverPublicKey,
  'method-name',
  requestData,
  {
    requestEncoding: MyRequestSchema,
    responseEncoding: MyResponseSchema,
    timeout: 5000
  }
)

await rpcClient.close()
```

### Client Wrapper Pattern

```javascript
class ServiceClient {
  constructor(serviceKey, rpcClient) {
    this.serviceKey = serviceKey
    this.rpcClient = rpcClient
  }

  async methodName(args) {
    return await this.rpcClient.makeRequest(
      this.serviceKey,
      'method-name',
      args,
      { 
        requestEncoding: ArgsSchema, 
        responseEncoding: ResultSchema 
      }
    )
  }
}
```

## Key Differences from Single-Writer

### Database Initialization

**Single-Writer:**
```javascript
const db = new Registry(store.get({ name: 'registry' }))
```

**Multi-Writer:**
```javascript
const service = new RegistryService(
  store.namespace('registry'),
  swarm,
  { autobaseBootstrap }
)
const db = service.view  // View is the database
```

### Write Operations

**Single-Writer:**
```javascript
await registry.put({ name, driveKey, type })
```

**Multi-Writer:**
```javascript
// Via service method
await service.putEntry({ name, driveKey, type })

// Or via RPC
await rpcClient.putEntry({ name, driveKey, type })
```

### Read Operations

**Single-Writer:**
```javascript
const entry = await registry.get('name')
```

**Multi-Writer:**
```javascript
// Through view
const entry = await service.view.get('name')

// Or direct replication (read-only)
const core = store.get(viewKey)
const registry = new Registry(core)
swarm.join(registry.discoveryKey, { client: true, server: false })
const entry = await registry.get('name')
```

## Testing Multi-Writer Setup

```javascript
const test = require('brittle')

test('multi-writer registry', async t => {
  // Setup 3 stores
  const store1 = new Corestore(await t.tmp())
  const store2 = new Corestore(await t.tmp())
  const store3 = new Corestore(await t.tmp())

  const swarm = new Hyperswarm()
  swarm.on('connection', c => {
    store1.replicate(c)
    store2.replicate(c)
    store3.replicate(c)
  })

  // Create first service
  const service1 = new RegistryService(
    store1.namespace('registry'),
    swarm,
    { ackInterval: 10 }
  )
  await service1.ready()

  // Bootstrap other services
  const service2 = new RegistryService(
    store2.namespace('registry'),
    swarm,
    { autobaseBootstrap: service1.base.key, ackInterval: 10 }
  )
  await service2.ready()

  const service3 = new RegistryService(
    store3.namespace('registry'),
    swarm,
    { autobaseBootstrap: service1.base.key, ackInterval: 10 }
  )
  await service3.ready()

  // Add writers
  await service1.addWriter(service2.base.local.key)
  await new Promise(resolve => {
    service2.base.once('is-indexer', resolve)
  })

  await service1.addWriter(service3.base.local.key)
  await new Promise(resolve => {
    service3.base.once('is-indexer', resolve)
  })

  // Test writes from different writers
  await service1.putEntry({ name: 'e1', driveKey: 'a'.repeat(64), type: 't1' })
  await service2.putEntry({ name: 'e2', driveKey: 'b'.repeat(64), type: 't2' })
  
  // Wait for sync
  await new Promise(resolve => setTimeout(resolve, 100))

  // Verify all can read
  t.ok(await service1.view.get('e1'))
  t.ok(await service1.view.get('e2'))
  t.ok(await service2.view.get('e1'))
  t.ok(await service2.view.get('e2'))
})
```

## Operational Considerations

### Writer Management

**Adding Writers:**
1. New instance joins with bootstrap key
2. Admin runs add-writer command
3. Wait for `is-indexer` event
4. Writer now participates in consensus

**Removing Writers:**
```javascript
// Add remove-writer operation
this.applyRouter.add(
  '@registry/remove-writer',
  async (data, context) => {
    await context.base.removeWriter(data.key)
  }
)

async removeWriter(key) {
  await this.base.append(
    dispatch('@registry/remove-writer', { key })
  )
}
```

### Backup Strategy

**DO NOT**: Backup corestore folders  
**DO**: Use blind peers or read-only replicas

**Blind Peer Pattern:**
```javascript
// Read-only instance that maintains full copy
const store = new Corestore('./backup-storage')
const swarm = new Hyperswarm()
swarm.on('connection', c => store.replicate(c))

// Join to replicate view
swarm.join(viewDiscoveryKey, { client: true, server: false })
```

### Disaster Recovery

**Scenario**: Writer instance permanently lost

**Recovery Steps:**
1. Ensure majority of writers still available (2 of 3)
2. Remove lost writer: `node bin.js admin-remove-writer <lost-key>`
3. Create new instance: `node bin.js run --storage new-store --bootstrap <autobase-key>`
4. Add new writer: `node bin.js admin-add-writer <new-local-key>`

### Monitoring

```javascript
// Track indexer status
service.base.on('is-indexer', () => {
  logger.info('Became indexer')
})

// Monitor view updates
service.view.db.watch(() => {
  logger.info(`View updated: length=${service.view.db.core.length}`)
})

// Connection monitoring
swarm.on('connection', (conn, info) => {
  logger.info(`Connected to ${IdEnc.normalize(info.publicKey)}`)
})
```

## Load Balancing with RPC Client Pool

```javascript
const ProtomuxRpcClientPool = require('protomux-rpc-client-pool')

const pool = new ProtomuxRpcClientPool(dht, {
  // Array of server keys
  servers: [key1, key2, key3],
  // Retry on different server if one fails
  retryOnError: true
})

// Automatically load balances across servers
await pool.makeRequest('put-entry', entry, {
  requestEncoding: EntryEnc,
  responseEncoding: cenc.none
})
```

## Consistency Model

### Eventually Consistent

- Writers append independently
- Linearization happens asynchronously
- Different writers may temporarily disagree
- System converges to consistent state

### Causal Ordering

Operations explicitly reference previous operations, creating DAG:

```
Writer 1: op1 → op2 → op4
                      ↑
Writer 2: op3 ────────┘
```

Linearizer ensures:
1. op4 never precedes op2 (causally dependent)
2. op1, op2, op3 may be reordered (independent)

### Signed Length

Autobase defines checkpoints where ordering becomes permanent:
- Requires majority of indexers writing
- Allows fast catch-up for lagging peers
- Reduces reordering overhead

## Advanced Patterns

### Optimistic Writes

```javascript
new Autobase(store, bootstrap, {
  optimistic: true,
  async apply(nodes, view, host) {
    for (const node of nodes) {
      const { value } = node
      
      // Verify optimistic write
      if (!verifySignature(value)) continue
      
      // Acknowledge writer if valid
      if (isValid(value)) {
        await host.ackWriter(node.from.key)
      }
      
      await view.append(value)
    }
  }
})

// Non-indexer can write optimistically
await base.append(data, { optimistic: true })
```

### Custom Context in Apply

```javascript
async _apply(nodes, view, base) {
  const context = {
    view,
    base,
    timestamp: Date.now(),
    validator: this.validator,
    // Any custom services
  }

  for (const node of nodes) {
    await this.applyRouter.dispatch(node.value, context)
  }
}
```

### Operation Versioning

```javascript
// In hyperschema, version operations
registry.register({
  name: 'put-entry-v2',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'driveKey', type: 'fixed32', required: true },
    { name: 'metadata', type: 'buffer', required: false }
  ]
})

// In dispatcher, handle both versions
this.applyRouter.add('@registry/put-entry', handler1)
this.applyRouter.add('@registry/put-entry-v2', handler2)
```

## Best Practices

### Schema Design

1. **Version operations explicitly** - allows migration
2. **Keep operations idempotent** - same operation applied twice = same result
3. **Design for reordering** - operations may be reordered during linearization
4. **Use schema validation** - hyperdispatch enforces types

### Apply Handler

1. **Must be deterministic** - same inputs = same outputs always
2. **Only modify view** - don't touch external state
3. **Handle errors gracefully** - failed operation shouldn't crash apply
4. **Keep operations atomic** - each operation is single logical unit

### Writer Management

1. **Start with 3 writers minimum** - allows single failure
2. **Use odd numbers** - simplifies majority consensus (3, 5, 7)
3. **Monitor indexer status** - ensure writers are synchronized
4. **Plan rotation procedures** - document writer addition/removal

### RPC Design

1. **Use typed encodings** - leverage hyperschema
2. **Set appropriate timeouts** - account for network latency
3. **Implement retry logic** - use RPC client pool
4. **Version endpoints** - allow backward-compatible updates

### Testing

1. **Test with 3+ writers** - verify multi-writer scenarios
2. **Simulate network partitions** - test eventual consistency
3. **Test writer rotation** - add/remove writers dynamically
4. **Verify replication** - ensure all writers converge

## Common Pitfalls

### Extension Not Disabled

```javascript
// WRONG - Autobase incompatible
const db = HyperDB.bee(core, spec, { extension: true })

// RIGHT
const db = HyperDB.bee(core, spec, { extension: false, autoUpdate: true })
```

### Non-Deterministic Apply

```javascript
// WRONG - uses external state
async _apply(nodes, view, base) {
  for (const node of nodes) {
    await this.externalDb.update(node.value) // External state!
  }
}

// RIGHT - only updates view
async _apply(nodes, view, base) {
  for (const node of nodes) {
    await view.put(node.value)
  }
}
```

### Forgetting to Wait for Indexer

```javascript
// WRONG - second writer may not be ready
await service1.addWriter(service2.base.local.key)
await service2.putEntry(entry) // May fail!

// RIGHT
await service1.addWriter(service2.base.local.key)
await new Promise(resolve => {
  service2.base.once('is-indexer', resolve)
})
await service2.putEntry(entry)
```

### Not Handling Reordering

```javascript
// WRONG - assumes ordering
this.applyRouter.add('@registry/create-user', async (data, ctx) => {
  await ctx.view.put({ id: data.id, name: data.name })
})
this.applyRouter.add('@registry/update-user', async (data, ctx) => {
  const user = await ctx.view.get(data.id) // May not exist yet!
  user.name = data.name
  await ctx.view.put(user)
})

// RIGHT - operations are independent
this.applyRouter.add('@registry/set-user', async (data, ctx) => {
  // Upsert pattern - works regardless of order
  await ctx.view.put({ id: data.id, name: data.name })
})
```

### Missing Namespace

```javascript
// WRONG - uses root store
const service = new RegistryService(store, swarm)

// RIGHT - uses namespace to avoid conflicts
const service = new RegistryService(
  store.namespace('registry'), 
  swarm
)
```

## Key Dependencies

- `autobase` (^7.18.1) - Multi-writer coordination
- `hyperdispatch` (^1.4.0) - Operation schema generation
- `protomux-rpc` (^1.7.1) - RPC server
- `protomux-rpc-client` (^2.0.2) - RPC client with connection management
- `protomux-rpc-client-pool` (^1.0.0) - Load balancing and failover
- `pino` / `pino-pretty` - Structured logging
- `paparam` - CLI argument parsing

## Resources

- [Autobase GitHub](https://github.com/holepunchto/autobase)
- [Hyperdispatch GitHub](https://github.com/holepunchto/hyperdispatch)
- [Protomux RPC GitHub](https://github.com/holepunchto/protomux-rpc)
- [Protomux RPC Client GitHub](https://github.com/holepunchto/protomux-rpc-client)
- [HyperDB Workshop](https://github.com/holepunchto/hyperdb-workshop)
- [Autobase DESIGN.md](https://github.com/holepunchto/autobase/blob/main/DESIGN.md)

## Workshop Assignment Checklist

**Completed in Demo:**
- [x] Create Autobase service with add-writer operation
- [x] Define operations with Hyperdispatch
- [x] Implement RPC layer (server and client)
- [x] Create CLI with run and admin-add-writer commands
- [x] Deploy 3-writer setup

**Assignment Tasks:**
- [ ] Add ability to remove writers
- [ ] Add delete-entry RPC endpoint
- [ ] Use protomux-rpc-client-pool for load balancing

## Architecture Comparison

### Single-Writer Stack

```
Application
    ↓
Registry (ReadyResource)
    ↓
HyperDB
    ↓
Hyperbee
    ↓
Hypercore (single writer)
    ↓
Corestore
```

### Multi-Writer Stack

```
Application / RPC Client
    ↓
ProtomuxRPC / RPC Client
    ↓
RegistryService
    ↓
Autobase
    ├── Writer 1 (local core)
    ├── Writer 2 (local core)
    └── Writer 3 (local core)
    ↓
Linearizer (Causal DAG)
    ↓
View (HyperDB)
    ↓
Hyperbee (extension: false)
    ↓
Hypercore (view)
    ↓
Corestore (namespaced)
```

## Production Deployment Summary

**Minimum Requirements:**
- 3 writer instances for HA
- Separate storage per instance
- Network connectivity between all instances
- Monitoring for indexer status

**Recommended Setup:**
- 5 writers for higher fault tolerance
- Load balancer (RPC client pool)
- Blind peers for backup
- Prometheus/Grafana monitoring
- Log aggregation (ELK/Loki)

**Scaling Considerations:**
- Add writers for write throughput
- Add blind peers for read throughput
- View key remains stable unless writers change
- Operations log grows indefinitely (plan storage)

**Security Considerations:**
- Protect writer private keys
- Use TLS for admin operations
- Validate all RPC inputs
- Rate limit RPC endpoints
- Monitor for unauthorized write attempts



