# QVAC Registry Deployment Guide

Production deployment guide for the QVAC Registry multi-writer indexers architecture with blind peer high availability.

For single-writer quickstart, see the [main README](../README.md#quick-start-single-writer).

## Overview

### Architecture Components

```
    ┌──────────────┐
    │  RPC Writer  │
    │              │           ┌─────────────────────────────────────────────┐
    │ add-model    │           │          QVAC Registry Cluster              │
    │ update-model │           ├─────────────────────────────────────────────┤
    │ delete-model │           │                                             │
    └──────┬───────┘           │  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
           │                   │  │ Indexer │  │ Indexer │  │ Indexer │     │
           │                   │  │    1    │◄►│    2    │◄►│    3    │     │
           │  RPC              │  ├─────────┤  ├─────────┤  ├─────────┤     │
           └──────────────────►│  │Autobase │  │Autobase │  │Autobase │     │
                               │  │HyperDB  │  │HyperDB  │  │HyperDB  │     │
                               │  │Blobs    │  │Blobs    │  │Blobs    │     │
                               │  │RPC Srv  │  │RPC Srv  │  │RPC Srv  │     │
                               │  └────┬────┘  └────┬────┘  └────┬────┘     │
                               │       └───────────┬┴───────────┘           │
                               │                   │                        │
                               └───────────────────┼────────────────────────┘
                                                   │
                              . . . . . . . . . . .│. . . . . . . . . . . . .
                                                  DHT
                              . . . . . . . . . . .│. . . . . . . . . . . . .
                                                   │
                       ┌───────────────────────────┼───────────────────────┐
                       │                           │                       │
                       ▼                           ▼                       ▼
             ┌──────────────┐             ┌──────────────┐        ┌──────────────┐
             │  Blind Peer  │             │  Blind Peer  │        │    Client    │
             │   (Mirror)   │             │   (Mirror)   │        │  (Read-only) │
             │              │             │              │        │              │
             │ Replicates + │             │ Replicates + │        │ Replicates   │
             │ announces    │             │ announces    │        │ DB + Blobs   │
             └──────────────┘             └──────────────┘        └──────────────┘
```

**Components:**

- **Autobase** – Linearizes operations from multiple writers into a deterministic log
- **HyperDB** – Queryable metadata store built on top of Autobase
- **Hyperblobs** – Storage for large model artifacts (GGUF files)
- **Hyperswarm** – P2P networking layer using DHT for peer discovery
- **RPC Writers** – Lightweight clients that submit data via RPC (e.g., `add-model`) without running the full indexer stack
- **Blind Peers** – Mirror nodes that replicate and announce data for high availability

### Key Terminology

| Term | Description |
|------|-------------|
| **Autobase key** | Identifies the shared log; additional writers bootstrap with this key |
| **Local key** | Each writer's unique public key (`service.base.local.key`) |
| **View key** | Identifies the HyperDB view that clients replicate |
| **Discovery key** | Derived from view key; used for DHT announcements |
| **Writer key** | RPC client keypair for authorized write operations |
| **DHT public key** | Hyperswarm identity; blind peers trust this key |

### Key Formats

Keys appear in two formats throughout the system:

| Format | Example | Usage |
|--------|---------|-------|
| **z-base-32** | `es4n7ty45odd1udf...` | CLI output, blind peer keys, human-readable |
| **hex** | `a1b2c3d4e5f6...` | `.env` files, programmatic usage |

Both formats are interchangeable. The `hypercore-id-encoding` library handles conversion.

## Prerequisites

### System Requirements

- Node.js ≥ 20
- `npm install` completed inside `registry-server/`
- `npm run build:spec` executed (generates hyperschema/hyperdb/hyperdispatch artifacts)
- Unique storage directory per writer (`./corestore`, `./store2`, `./store3`, …)

### Network Requirements

The registry uses HyperDHT for peer discovery and UDP hole punching for P2P connectivity.

**Known facts:**
- Connects to public DHT bootstrap nodes (default: `node1.hyperdht.org:49737`, `node2.hyperdht.org:49737`, `node3.hyperdht.org:49737`)
- Uses UDP hole punching – works behind most NATs without explicit port forwarding
- DHT port binding is dynamic by default (can be set with `--port` flag)

**TODO: Document based on production experience:**
- Specific firewall rules for corporate networks
- Bandwidth requirements for model distribution
- Latency considerations for geographically distributed writers

## Multi-Writer Production Setup

### Step 1: Start First Writer (Primary Indexer)

On the primary machine:

```bash
node scripts/bin.js run --storage ./prod-corestore
```

The command prints:

- **Autobase key** (saved to `.env` as `QVAC_AUTOBASE_KEY`)
- **Registry view key** (saved to `.env` as `QVAC_REGISTRY_CORE_KEY`)
- **Registry discovery key**
- **RPC server public key** (z-base-32, needed for blind peer trust)
- **Writer local key** (z-base-32, needed when adding more writers)

The `.env` file is automatically created. Keep the Autobase key safe – it's the only secret required to add writers.

Leave this writer running.

### Step 2: Start Blind Peer(s) for High Availability

On separate machine(s), start blind peer mirrors:

```bash
npm run run-blind-peer -- \
  --storage ./blind-peer-data \
  --trusted <RPC_SERVER_PUBLIC_KEY_FROM_STEP_1>
```

The blind peer prints its public key (z-base-32). Copy this key.

**Trust configuration**: The `--trusted` flag allows the registry to request `announce: true` for the database. Without trust, the blind peer rejects announcement requests.

### Step 3: Authorize Writer RPC Clients

Only allowlisted keys can call the `add-model` RPC.

**Initialize a writer client:**

```bash
node scripts/bin.js init-writer --storage ./writer-storage
```

This command:
1. Creates a deterministic keypair from the storage path
2. Prints the public key (z-base-32 and hex)
3. Appends the hex key to `QVAC_ALLOWED_WRITER_KEYS` in `.env`

**Restart the indexer** for changes to take effect.

For multiple writer clients (e.g., CI jobs):

```bash
QVAC_ALLOWED_WRITER_KEYS=<key1>,<key2>,<key3>
```

**Important**: When calling `add-model`, use the **same storage path**:

```bash
npm run add-model -- <source-url> --storage ./writer-storage
```

### Step 4: Connect Registry to Blind Peers

Stop the first writer (Ctrl+C) and restart with blind peer configuration:

```bash
node scripts/bin.js run \
  --storage ./prod-corestore \
  --blind-peers <BLIND_PEER_KEY_1>,<BLIND_PEER_KEY_2> --clear-after-reseed
```

Or set via environment variable:

```bash
export QVAC_BLIND_PEER_KEYS=<BLIND_PEER_KEY_1>,<BLIND_PEER_KEY_2>
node scripts/bin.js run --storage ./prod-corestore
```

During startup with blind peers, the registry will:
1. Initialize blind peer replication
2. Mirror existing blob cores to blind peers
3. Wait for initial sync (if cores pending)
4. Log: `Registry service ready`

**Database announcement**: The registry automatically adds the database to blind peers. Clients discover blind peers via the database discovery key, then download all data (including blobs) over the same connection.

### Step 5: Add Additional Writers

On each additional writer machine:

1. **Start the writer with the Autobase key:**

   ```bash
   node scripts/bin.js run \
     --storage ./writer-corestore \
     --bootstrap <AUTOBASE_KEY_FROM_STEP_1>
   ```

   Copy the printed **local key** (z-base-32).

   **Note**: If you're testing multiple writers on a single machine sharing the same `.env` file, add `--skip-storage-check` to bypass the storage/bootstrap key mismatch check:

   ```bash
   node scripts/bin.js run \
     --storage ./writer-corestore \
     --bootstrap <AUTOBASE_KEY_FROM_STEP_1> \
     --skip-storage-check
   ```

   This flag is only needed when `QVAC_AUTOBASE_KEY` is already set in `.env` (from Writer 1) and you're starting a fresh writer with a new storage directory. It's not needed in production where each writer has its own isolated environment.

2. **Wait for DHT discovery** (first-time only):
   - Fresh discovery keys take 30-60 seconds to propagate
   - Subsequent restarts don't require waiting

### Step 6: Promote Writers to Indexers

On the **primary indexer machine**, add new writer keys to `.env`:

```bash
QVAC_ADDITIONAL_INDEXERS=<writer2-local-key>,<writer3-local-key>
```

Restart the primary indexer:

```bash
node scripts/bin.js run \
  --storage ./prod-corestore \
  --blind-peers <BLIND_PEER_KEYS> --clear-after-reseed
```

On startup, it automatically promotes writers listed in `QVAC_ADDITIONAL_INDEXERS` to indexers.

Watch each writer's logs for: `RegistryService: I have become an indexer`

### Step 7: Initial Model Seeding

Bulk upload models from a JSON configuration:

**Note**: For production setup, use `models.prod.json` which will download around 150 GB of models.

```bash
node scripts/add-all-models.js \
  --file=./data/models.test.json \
  --storage ./writer-storage \
  --skipExisting
```

**Verify models are accessible using the client package:**

```bash
cd client

# List all models
node examples/example.js

# Download a model to verify blob storage
node examples/download-model.js

# Download all models
node examples/download-all-models.js
```

### Step 8: Confirm Replication

After all writers are indexers:

- Each instance should log the same HyperDB view key and discovery key
- Adding models via any writer propagates to all other writers
- Blind peers should show `Core fully downloaded` for each blob core

## Operations

### Adding a Writer

1. Start new writer with `--bootstrap <autobase-key>`
2. Copy its local key from logs
3. Add to `QVAC_ADDITIONAL_INDEXERS` on primary indexer
4. Restart primary indexer
5. Wait for `I have become an indexer` on new writer

### Removing a Writer

1. Stop the writer to be removed
2. Remove its key from `QVAC_ADDITIONAL_INDEXERS`
3. Restart an existing indexer
4. Optionally start a replacement writer

### Sync Models from JSON Config

Preview changes:

```bash
node scripts/bin.js sync-models \
  --file=./data/models.prod.json \
  --dry-run
```

Apply changes:

```bash
node scripts/bin.js sync-models \
  --file=./data/models.prod.json
```

The sync script adds new models and updates metadata for existing models. Licenses are auto-created from `data/licenses/` when needed.

### Verifying Replication Health

1. **Check indexer status**: All writers should log `I have become an indexer`
2. **Verify view keys match**: All writers should report the same HyperDB view key
3. **Test model operations**: Add a model via one writer, verify it appears on others
4. **Check blind peer sync**: Blind peers should log `Core fully downloaded` for each core

TODO: automate this check (we can also introduce health endpoint)

### Data Redundancy

In a P2P multi-writer architecture with blind peers, data is inherently replicated across all peers. Traditional backups are not recommended – restoring from backup could cause consistency issues with the distributed state.

**Redundancy strategy:**
- Run 3+ writers for write availability
- Run 2+ blind peers for read availability
- Geographic distribution across regions for disaster recovery

## Troubleshooting

### "Timeout: Could not connect to service"

The RPC client couldn't discover any writer via DHT.

**Solutions:**

1. **Verify `.env` has correct keys:**
   ```bash
   cat .env
   # QVAC_REGISTRY_CORE_KEY should match "Registry view key" from writer logs
   ```

2. **Wait for DHT propagation** (first-time only):
   - Fresh discovery keys take 30-60 seconds to propagate
   - Subsequent restarts work immediately

3. **Verify writers are running:**
   ```bash
   ps aux | grep "scripts/bin.js run"
   ```

### "Not writable" / "Request failed: Not writable"

The service automatically waits for indexer status. This error is rare.

**Why it can happen:**
- RPC client connected during startup
- Timeout waiting for indexer status (30s default)

**Solutions:**

1. Wait a few seconds and retry
2. Verify the writer is an indexer:
   ```bash
   grep "I have become an indexer" <writer-log>
   ```

### "unauthorized writer request"

The RPC call was rejected.

**Causes:**

1. **Writer key not in allowlist**: Run `init-writer` to authorize
2. **Storage directory mismatch**: `--storage` must match between `init-writer` and `add-model`

### "Configuration error: QVAC_AUTOBASE_KEY is set but storage appears fresh"

Mismatch between `.env` and storage state.

**Solutions:**

```bash
# Option 1: Clean start (remove both storage and env keys)
rm -rf ./corestore
sed -i '' '/QVAC_AUTOBASE_KEY/d' .env
sed -i '' '/QVAC_REGISTRY_CORE_KEY/d' .env

# Option 2: Use the original storage directory

# Option 3: Skip the check when intentionally joining with fresh storage
node scripts/bin.js run --storage ./new-writer --bootstrap <key> --skip-storage-check
```

**When to use `--skip-storage-check`**: Use this flag when you're intentionally starting a new writer with fresh storage to join an existing cluster, and `QVAC_AUTOBASE_KEY` is already set in your environment (e.g., shared `.env` file during multi-writer testing on a single machine).

### "Blind peer not replicating"

**Check:**
- Trust is configured: Blind peer must trust the registry's **RPC server public key**
- Network connectivity between registry and blind peer
- Registry logs show `addCore` calls for blob cores

### First-Time Setup vs Subsequent Restarts

| Aspect | First-Time Setup | Subsequent Restarts |
|--------|------------------|---------------------|
| DHT discovery | 30-60 second wait | Instant (keys persist) |
| Admin command retries | May need 1-2 retries | Usually works first try |
| Writer coordination | Manual timing recommended | Automated/scripted works |

## Reference

### Environment Variables

| Variable | Description |
|----------|-------------|
| `QVAC_AUTOBASE_KEY` | Autobase bootstrap key (auto-generated on first run) |
| `QVAC_REGISTRY_CORE_KEY` | Registry view key (auto-generated on first run) |
| `QVAC_ADDITIONAL_INDEXERS` | Comma-separated writer local keys to promote to indexers |
| `QVAC_ALLOWED_WRITER_KEYS` | Comma-separated hex keys allowed to call add-model RPC |
| `QVAC_BLIND_PEER_KEYS` | Comma-separated blind peer public keys for replication |
| `QVAC_PRIMARY_KEY` | Optional: Deterministic key generation (testing only) |
| `QVAC_WRITER_PRIMARY_KEY` | Optional: Deterministic writer key (testing only) |

### Command Reference

| Command | Description |
|---------|-------------|
| `node scripts/bin.js run --storage <path>` | Start a writer |
| `node scripts/bin.js run --bootstrap <key>` | Join existing cluster |
| `node scripts/bin.js run --blind-peers <keys>` | Enable blind peer replication |
| `node scripts/bin.js run --skip-storage-check` | Bypass storage/bootstrap key mismatch check |
| `node scripts/bin.js init-writer --storage <path>` | Initialize/authorize a writer client |
| `node scripts/bin.js sync-models --file <path>` | Sync models from JSON config |
| `npm run add-model -- <url> --storage <path>` | Add a single model |
| `npm run run-blind-peer -- --storage <path> --trusted <key>` | Start a blind peer |

### Reproducible Keys (Testing Only)

For testing, you can use deterministic keys:

```bash
# Generate a primary key
node scripts/generate-primary-key.js

# Or from a passphrase (deterministic)
node scripts/generate-primary-key.js --passphrase "my-test-seed"
```

Use with:

```bash
node scripts/bin.js run --primary-key <hex-key> --storage ./corestore
```

**Security Warning**: Reproducible keys are for testing/development only. In production, use random key generation (default).


