# HyperDB Workshop Learnings

## Overview

HyperDB is a schema-based database built for P2P and local indexing, sitting atop the Holepunch distributed stack. It solves efficient lookup problems that are difficult in Hyperbee while providing automatic code generation, versioning, and multi-index support.

## Holepunch Stack Architecture

### Data Layer (Bottom to Top)

**Hypercore**
- Append-only log structure
- Sparse replication support
- Forms the base for all higher-level structures

**Hyperbee**
- B-tree database built on Hypercore
- Efficient key-based lookup
- Iterator support
- Limitation: only efficient for primary key lookups

**HyperDB**
- Schema-driven database
- Multiple index support
- Code generation via schemas
- Efficient search across multiple fields

### Discovery Layer

**HyperDHT**
- Create network servers
- Announce topics (public keys)
- Connect peers via key → ip+port resolution
- Lookup topics → peer keys

**Hyperswarm**
- Continuous swarming on topics
- Lookup: key → connections
- Announce: key → connections
- Higher-level abstraction over HyperDHT

### Connection Layer

**UDX**: UDP-based streams  
**Hyperswarm Secret Stream**: End-to-end encryption  
**Protomux**: Protocol multiplexing over single connection  
**Protomux RPC**: Remote procedure calls over Protomux

## Core Problem: Why HyperDB?

### Hyperbee Limitations

Given a registry of AI models:

| Model  | driveKey | type       |
|--------|----------|------------|
| en-fr  | aaaa     | translate  |
| en-it  | bbbb     | translate  |
| en-gen | dddd     | generation |

**Hyperbee supports:**
- ✓ Find driveKey of en-fr (primary key lookup)
- ✓ Find all models starting with "en" (prefix scan)

**Hyperbee struggles with:**
- ✗ Find model name given driveKey 'aaaa'
- ✗ Find all models of type 'translate'

### HyperDB Solution

**Secondary Indexes**: Define indexes on any field for efficient lookups  
**Schema Enforcement**: Compile-time schema validation  
**Code Generation**: Automatic encoding/decoding  
**Versioning**: Built-in schema version management

## Schema Definition Pattern

### 1. Schema Setup (build.js)

```javascript
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const SCHEMA_DIR = path.join(__dirname, 'spec', 'hyperschema')
const DB_DIR = path.join(__dirname, 'spec', 'hyperdb')

function setupSchema() {
  const schema = Hyperschema.from(SCHEMA_DIR)
  const registry = schema.namespace('registry')

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

  Hyperschema.toDisk(schema)
}
```

### 2. Database Definition (build.js)

```javascript
function setupDb() {
  const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
  const dbNs = db.namespace('registry')

  // Define collection with primary key
  dbNs.collections.register({
    name: 'entry',
    schema: '@registry/entry',
    key: ['name'] // Primary key
  })

  // Define secondary indexes
  dbNs.indexes.register({
    name: 'entry-by-drive-key',
    collection: '@registry/entry',
    key: ['driveKey'],
    unique: true // One-to-one mapping
  })

  dbNs.indexes.register({
    name: 'entry-by-type',
    collection: '@registry/entry',
    key: ['type'] // One-to-many: multiple entries per type
  })

  dbNs.indexes.register({
    name: 'entry-by-owner',
    collection: '@registry/entry',
    key: ['owner']
  })

  HyperDB.toDisk(db)
}
```

### 3. Execute Build

```bash
node build.js
```

This generates:
- `spec/hyperschema/schema.json` - Schema definitions
- `spec/hyperdb/index.js` - Generated encoders/decoders
- `spec/hyperdb/messages.js` - Message encodings

## Runtime API Patterns

### Database Initialization

```javascript
const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const spec = require('./spec/hyperdb')

class Registry extends ReadyResource {
  constructor(core) {
    super()
    // Hyperbee-backed database
    this.db = HyperDB.bee(core, spec, { autoUpdate: true })
  }

  async _open() {
    await this.db.ready()
  }

  async _close() {
    await this.db.close()
  }
}
```

**Key Options:**
- `autoUpdate: true` - Automatically update when underlying Hyperbee updates
- `extension: false` - Required when using with Autobase
- `writable: true` - Whether database accepts writes

### CRUD Operations

**Insert (Transaction Required)**

```javascript
async put({ name, driveKey, type, description = null, owner = null }) {
  driveKey = IdEnc.decode(driveKey) // Convert hex to buffer
  
  const tx = this.db.transaction()
  await tx.insert('@registry/entry', { name, driveKey, type, description, owner })
  await tx.flush() // Commit transaction
}
```

**Delete**

```javascript
async delete(name) {
  const tx = this.db.transaction()
  await tx.delete('@registry/entry', { name })
  await tx.flush()
}
```

**Get by Primary Key**

```javascript
async get(name) {
  return await this.db.get('@registry/entry', { name })
}
```

**Query by Index (Single Result)**

```javascript
async getByDriveKey(driveKey) {
  driveKey = IdEnc.decode(driveKey)
  
  return await this.db.findOne(
    '@registry/entry-by-drive-key',
    { gte: { driveKey }, lte: { driveKey } }
  )
}
```

**Query by Index (Stream)**

```javascript
getEntriesOfType(type) {
  return this.db.find(
    '@registry/entry-by-type',
    { gte: { type }, lte: { type } }
  )
}

// Usage
for await (const entry of registry.getEntriesOfType('translation')) {
  console.log(entry)
}
```

### Transaction Patterns

**Basic Transaction**

```javascript
const tx = db.transaction()
try {
  await tx.insert('@ns/collection', record)
  await tx.flush() // Commits and closes
} catch (err) {
  await tx.close() // Must close on error
}
```

**Exclusive Transaction (with Lock)**

```javascript
const tx = await db.exclusiveTransaction()
// Guaranteed no concurrent transactions
await tx.insert('@ns/collection', record)
await tx.flush()
```

**Warnings:**
- Transactions must always be closed
- Transactions must not run in parallel (use `exclusiveTransaction()` for automatic locking)
- Flushing closes the transaction

## Networking Patterns

### Server Setup

```javascript
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const goodbye = require('graceful-goodbye')

async function main() {
  const store = new Corestore('./storage')
  await store.ready()

  // Consistent keypair across restarts
  const swarm = new Hyperswarm({
    keyPair: await store.createKeyPair('public-key')
  })

  // Handle connections - CRITICAL for replication
  swarm.on('connection', (conn, peerInfo) => {
    store.replicate(conn)
    console.log(`Connected to ${IdEnc.normalize(peerInfo.publicKey)}`)
  })

  const registry = new Registry(store.get({ name: 'registry' }))
  await registry.ready()

  // Announce as server
  swarm.join(registry.discoveryKey, { client: false, server: true })
  
  console.log(`Registry at ${IdEnc.normalize(registry.publicKey)}`)

  goodbye(async () => {
    await swarm.destroy()
    await registry.close()
  })
}
```

### Client Lookup

```javascript
async function client() {
  const key = process.argv[2] // Registry public key
  const store = new Corestore('./client-storage')
  
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))

  const core = store.get(IdEnc.decode(key))
  const registry = new Registry(core)
  await registry.ready()

  // Join as client
  swarm.join(registry.discoveryKey, { client: true, server: false })

  // Wait for replication (first-time connection)
  await new Promise(resolve => setTimeout(resolve, 1000))

  const entry = await registry.get('model-name')
  console.log(entry)

  await swarm.destroy()
  await registry.close()
}
```

**Key Concepts:**
- `publicKey`: Uniquely identifies the database
- `discoveryKey`: Used for swarming (non-sensitive)
- `store.replicate(conn)`: Essential for data sync
- First connection requires wait time for replication

## Advanced: Multi-Writer with Autobase

### Problem

Single-writer databases have:
- No high availability (single point of failure)
- No safe backup strategy (copying corestore corrupts hypercore)

### Solution: Autobase

**Event Sourcing Pattern**: Multiple writers append operations; Autobase linearizes into consistent view.

**Benefits (3-Writer Setup):**
- 1 writer down: service continues processing
- 2 writers down: service accepts requests (processed when writers return)
- 1 writer lost (disk crash): rotate out with remaining 2, add new writer

### Autobase Configuration

```javascript
this.db = HyperDB.bee(core, spec, { 
  extension: false,  // REQUIRED for Autobase
  autoUpdate: true 
})
```

### Architecture with Autobase

```
┌─────────────────────────────────────────────────┐
│                   Autobase                      │
│  (Linearizes operations from multiple writers)  │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
           ┌───────────────┐
           │  View (DB)    │
           │  (HyperDB)    │
           └───────────────┘
```

**Key Components:**
- **Writers**: Append operations to their individual cores
- **Autobase**: Linearizes operations using causal DAG
- **View**: Resulting consistent database state
- **Hyperdispatch**: Schema-based operation definitions

## Index Design Patterns

### Simple Field Index

```javascript
dbNs.indexes.register({
  name: 'entry-by-type',
  collection: '@registry/entry',
  key: ['type'],
  unique: false // Multiple entries per type
})
```

### Unique Index

```javascript
dbNs.indexes.register({
  name: 'entry-by-drive-key',
  collection: '@registry/entry',
  key: ['driveKey'],
  unique: true // One entry per driveKey
})
```

### Composite Index

```javascript
// Index includes type AND name for uniqueness
dbNs.indexes.register({
  name: 'entry-by-type',
  collection: '@registry/entry',
  key: ['type', 'name'] // Auto-added if unique: false
})
```

### Nested Field Index

```javascript
// Access nested struct fields with dot notation
dbNs.collections.register({
  name: 'nested-collection',
  schema: '@db/nested',
  key: ['foo.id'] // Uses nested struct's id field
})
```

### Custom Mapping Index

```javascript
// helpers.js
exports.mapNameToLowerCase = (record, context) => {
  const name = record.name.toLowerCase().trim()
  return name ? [name] : []
}

// build.js
db.require('./helpers.js')

dbNs.indexes.register({
  name: 'entry-by-lower-name',
  collection: '@registry/entry',
  unique: true,
  key: {
    type: 'string',
    map: 'mapNameToLowerCase'
  }
})
```

## Query Patterns

### Exact Match

```javascript
// Using gte + lte with same value
const entry = await db.findOne(
  '@registry/entry-by-type',
  { gte: { type: 'translate' }, lte: { type: 'translate' } }
)
```

### Range Query

```javascript
// Stream results in range
const stream = db.find(
  '@registry/entry-by-date',
  { 
    gte: { date: '2025-01-01' },
    lte: { date: '2025-12-31' }
  }
)
```

### Prefix Scan

```javascript
// All entries starting with 'en'
const stream = db.find(
  '@registry/entry',
  { 
    gte: { name: 'en' },
    lte: { name: 'en\xff' }
  }
)
```

### Limiting Results

```javascript
const stream = db.find(
  '@registry/entry-by-type',
  { gte: { type }, lte: { type } },
  { limit: 10, reverse: false }
)
```

### Stream Helpers

```javascript
// Get all results
const all = await queryStream.toArray()

// Get single result
const one = await queryStream.one()

// Shorthand
const doc = await db.findOne('@registry/entry-by-type', query)
```

## Collection Triggers

Triggers run when collection entries are modified, useful for maintaining derived collections.

```javascript
// helpers.js
exports.membersTrigger = async function (db, key, record) {
  const [digest, previous] = await Promise.all([
    db.get('@ns/members-digest'),
    db.get('@ns/members', key)
  ])

  if (!digest) digest = { members: 0 }

  const wasInserted = !!previous
  const isInserted = !!record

  if (!wasInserted && isInserted) digest.members += 1
  if (wasInserted && !isInserted) digest.members -= 1

  await db.insert('@ns/members-digest', digest)
}

// build.js
db.require('./helpers.js')

db.collections.register({
  name: 'members',
  trigger: 'membersTrigger',
  key: ['name'],
  schema: '@ns/members'
})
```

## Schema Evolution

### Adding Optional Fields

```javascript
// SAFE: Add optional field
registry.register({
  name: 'entry',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'owner', type: 'string', required: false } // New optional field
  ]
})
```

### Breaking Changes

```javascript
// UNSAFE: Adding required field to existing schema
// This will error during build - requires migration
registry.register({
  name: 'entry',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'newRequired', type: 'string', required: true } // ERROR
  ]
})
```

**Schema Version Management:**
- Builder enforces backwards compatibility
- Breaking changes must go through migration process
- Optional fields can be added without migration

## Storage Backends

### Hyperbee (P2P)

```javascript
const core = store.get({ name: 'db-name' })
const db = HyperDB.bee(core, spec, { autoUpdate: true })
```

**Characteristics:**
- P2P replication
- Sparse downloads
- Requires external replication setup
- No automatic updates (use `autoUpdate: true`)

### RocksDB (Local)

```javascript
const db = HyperDB.rocks('./my-rocks.db', spec)
```

**Characteristics:**
- Local-only
- Full indexing
- Faster queries
- No network overhead

## Testing Patterns

```javascript
const test = require('brittle')
const Corestore = require('corestore')

test('put and get record', async t => {
  const store = new Corestore(await t.tmp())
  const registry = new Registry(store.get({ name: 'registry' }))

  t.teardown(async () => {
    await registry.close()
    await store.close()
  })

  await registry.put({
    name: 'model-1',
    driveKey: 'a'.repeat(64),
    type: 'translate'
  })

  const entry = await registry.get('model-1')
  t.ok(entry, 'entry exists')
  t.is(entry.name, 'model-1')
})

// Stream testing
async function consumeStream(stream, mapper) {
  const res = []
  for await (const e of stream) res.push(mapper ? mapper(e) : e)
  return res
}

test('query by type', async t => {
  const entries = await consumeStream(
    registry.getEntriesOfType('translate'),
    e => e.name
  )
  t.alike(new Set(entries), new Set(['model-1', 'model-2']))
})
```

## Best Practices

### Schema Design

1. **Define all lookup patterns upfront** - indexes can't be added without migration
2. **Use optional fields for extensibility** - allows schema evolution
3. **Namespace consistently** - `@namespace/name` pattern
4. **Index cardinality** - use `unique: true` for 1:1, false for 1:many

### Database Operations

1. **Always use transactions** for writes
2. **Close transactions on error** - prevents resource leaks
3. **Use `autoUpdate: true`** for Hyperbee unless manually managing
4. **Decode keys consistently** - use `hypercore-id-encoding`

### Networking

1. **Always replicate on connection** - `store.replicate(conn)` is essential
2. **Use discoveryKey for swarming** - never expose private keys
3. **Stable keypairs** - use `store.createKeyPair()` for consistent identity
4. **Graceful shutdown** - use `graceful-goodbye` for cleanup

### Production Considerations

1. **Use Autobase for multi-writer** - provides HA and safe backups
2. **Never copy corestore directories** - causes corruption
3. **Use protomux-rpc for mutations** - clean RPC pattern for writes
4. **Implement health checks** - monitor writer availability
5. **Test replication delays** - P2P sync is not instantaneous

## Common Pitfalls

**Missing replication setup:**
```javascript
// WRONG - no replication
swarm.on('connection', conn => {
  console.log('connected')
})

// RIGHT
swarm.on('connection', conn => store.replicate(conn))
```

**Forgetting to flush:**
```javascript
// WRONG - changes not committed
await db.insert('@ns/collection', record)

// RIGHT
const tx = db.transaction()
await tx.insert('@ns/collection', record)
await tx.flush()
```

**Not closing transactions on error:**
```javascript
// WRONG - resource leak
const tx = db.transaction()
throw new Error('oops')

// RIGHT
const tx = db.transaction()
try {
  await tx.insert('@ns/collection', record)
  await tx.flush()
} catch (err) {
  await tx.close()
  throw err
}
```

**Using extension with Autobase:**
```javascript
// WRONG - Autobase incompatible
const db = HyperDB.bee(core, spec, { extension: true })

// RIGHT
const db = HyperDB.bee(core, spec, { extension: false, autoUpdate: true })
```

## Key Dependencies

- `hyperdb` - Main database library
- `hyperschema` - Schema definition and code generation
- `corestore` - Storage for hypercores
- `hyperswarm` - P2P networking
- `hypercore-id-encoding` - Key encoding utilities
- `ready-resource` - Resource lifecycle management
- `graceful-goodbye` - Clean shutdown handling
- `autobase` - Multi-writer coordination (advanced)
- `hyperdispatch` - Operation schemas for Autobase (advanced)
- `protomux-rpc` - RPC framework (advanced)

## Resources

- [HyperDB GitHub](https://github.com/holepunchto/hyperdb)
- [Hyperschema GitHub](https://github.com/holepunchto/hyperschema)
- [Autobase GitHub](https://github.com/holepunchto/autobase)
- [Holepunch Organization](https://github.com/holepunchto)

## Workshop Completion Checklist

- [x] Define schemas in `build.js`
- [x] Create collections with primary keys
- [x] Add secondary indexes
- [x] Implement CRUD operations
- [x] Query by primary key
- [x] Query by secondary index
- [x] Implement delete operation
- [x] Add optional fields (owner)
- [x] Network server setup
- [x] Network client lookup
- [ ] RPC layer for remote mutations
- [ ] Multi-writer with Autobase (advanced)

## Architecture Summary

```
Application Layer
├── Registry Class (ReadyResource)
│   ├── CRUD methods (put, get, delete)
│   └── Query methods (getByDriveKey, getEntriesOfType)
│
├── HyperDB Instance
│   ├── Transactions (insert, delete, flush)
│   ├── Queries (get, find, findOne)
│   └── Snapshots (snapshot, transaction)
│
├── Generated Spec (build.js output)
│   ├── Collections (encoders, decoders)
│   ├── Indexes (key encoders, reconstructors)
│   └── Messages (schema encodings)
│
├── Hyperbee (B-tree)
│   └── Hypercore (append-only log)
│
└── Corestore (storage manager)
    └── File system

Network Layer
├── Hyperswarm (swarming)
│   ├── HyperDHT (discovery)
│   └── Secret Stream (encryption)
│
└── Protomux (multiplexing)
    └── Protomux RPC (optional, for mutations)
```



