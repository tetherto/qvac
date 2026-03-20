---
name: holepunch-dev
description: Guides discovery and development with Holepunch ecosystem libraries. Use when working with P2P stack (Hypercore, Hyperswarm, Autobase), Bare runtime (bare-* modules), or Pear app framework (pear-* modules). Teaches on-the-fly API discovery via gh CLI and docs.pears.com.
---

# Holepunch Development

Ecosystem navigator for Holepunch/Bare/Pear development. Teaches the agent to discover APIs on-the-fly rather than carrying static knowledge dumps.

## When to use this skill

**Use when:**
- Working with any holepunch/hyper*/bare-*/pear-* library
- P2P networking, distributed data structures, peer discovery
- Bare runtime (Node.js-equivalent modules for embedded/cross-platform)
- Pear application development (pear init, pear run, pear-electron)

**Triggers:** holepunch, hypercore, hyperswarm, autobase, hyperdb, corestore, bare-fs, pear-electron, P2P, pear runtime

## Ecosystem Map

### P2P Stack

See [references/p2p-libraries.md](references/p2p-libraries.md) for full catalog.

| Layer | Libraries |
|-------|-----------|
| Networking | hyperswarm, hyperdht |
| Core Data | hypercore, corestore |
| KV Database | hyperbee |
| Schema DB | hyperdb, hyperschema, hyperdispatch |
| Files | hyperdrive, localdrive, mirror-drive |
| Multi-writer | autobase |
| Pairing | blind-pairing, blind-peering |
| Connection | protomux, protomux-rpc, @hyperswarm/secret-stream |
| Encoding | compact-encoding, b4a |
| Utilities | ready-resource, safety-catch, protomux-wakeup |

### Bare Runtime

See [references/bare-modules.md](references/bare-modules.md). ~50 modules, mostly Node.js standard library equivalents (bare-fs = fs, bare-crypto = crypto, bare-tcp = net). Agent familiar with Node.js needs the mapping table only.

### Pear Framework

See [references/pear-framework.md](references/pear-framework.md). ~24 modules across 5 categories. Full app lifecycle: init, run, stage, seed, release. Key complex module: pear-electron (100+ methods for desktop UI).

## Discovery Playbook

When you need to learn about a Holepunch library, follow these steps in order. Do not stop at the first source if the API surface is still unclear.

### Step 1: docs.pears.com

Navigation hub. How-to guides contain working examples. Building-block pages redirect to GitHub; the how-to guides have actual code.

- Building blocks overview: https://docs.pears.com/index.html#building-blocks
- How-tos (examples):
  - https://docs.pears.com/howto/connect-two-peers-by-key-with-hyperdht.html
  - https://docs.pears.com/howto/connect-to-many-peers-by-topic-with-hyperswarm.html
  - https://docs.pears.com/howto/replicate-and-persist-with-hypercore.html
  - https://docs.pears.com/howto/work-with-many-hypercores-using-corestore.html
  - https://docs.pears.com/howto/share-append-only-databases-with-hyperbee.html
  - https://docs.pears.com/howto/create-a-full-peer-to-peer-filesystem-with-hyperdrive.html

### Step 2: GitHub README

Primary API documentation lives in README files:

```bash
gh api repos/holepunchto/{repo}/readme --jq .content | base64 -d
```

### Step 3: Test files

Holepunch repos have excellent tests that show real usage patterns:

```bash
gh api repos/holepunchto/{repo}/contents/test
# Then fetch specific test files for usage examples
```

### Step 4: Example repos

For higher-level integration patterns:

```bash
gh api repos/holepunchto/examples/contents
```

### Step 5: Workshop repos

Guided tutorials for specific topics (HyperDB, Autobase multi-writer, Pear apps):

```bash
gh api "search/repositories?q=org:holepunchto+workshop+in:name" --jq '.items[] | "\(.full_name) - \(.description)"'
```

Known workshops: `pear-workshop`, `hyperdb-workshop`, `hyperdb-autobase-workshop`.

### Step 6: Dependency traversal

Holepunch dependency trees are deep. When a library references another holepunch library, follow the chain:

```bash
gh api repos/holepunchto/{repo}/contents/package.json --jq .content | base64 -d \
  | jq '.dependencies // {} | keys[] | select(test("hyper|autobase|corestore|protomux|blind-|compact-encoding|b4a|ready-resource|safety-catch"))'
```

Recursively fetch READMEs/tests for any holepunch dependency relevant to the current task. Do not stop at the first library; trace the dependency graph until the needed API surface is understood.

### Step 7: Keet repos (optional, requires access)

For bleeding-edge patterns not yet in dedicated libraries. These repos may be private; skip gracefully on 404:

```bash
gh api "search/repositories?q=org:holepunchto+keet+in:name" --jq '.items[].full_name'
```

### Step 8: Source code

When README is insufficient, read index.js or lib/ directly:

```bash
gh api repos/holepunchto/{repo}/contents/index.js --jq .content | base64 -d
gh api repos/holepunchto/{repo}/contents/lib --jq '.[].name'
```

## Composition Patterns

### P2P KV Database (simplest)

Corestore + Hyperswarm + Hyperbee:

```javascript
const store = new Corestore(storage)
const core = store.get({ name: 'my-db' })
const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'utf-8' })
await store.ready()

const swarm = new Hyperswarm()
swarm.on('connection', conn => store.replicate(conn))
swarm.join(core.discoveryKey)
```

### P2P Multi-writer DB

Corestore + Hyperswarm + Autobase + HyperDB + Hyperschema + Hyperdispatch. Full schema pipeline: define schema in Hyperschema, build collections with HyperDB builder, define routes in Hyperdispatch. Autobase `open()` returns HyperDB.bee instance; `apply()` dispatches operations via router; call `view.flush()` after batch.

### P2P File Sharing

Corestore + Hyperswarm + Hyperdrive:

```javascript
const store = new Corestore(storage)
const drive = new Hyperdrive(store)
await drive.ready()

const swarm = new Hyperswarm()
swarm.on('connection', conn => drive.replicate(conn))
swarm.join(drive.discoveryKey)
```

## Verified Gotchas

**Policy: Only document verified facts.** Each gotcha is sourced from real production experience. Do NOT invent or speculate about additional gotchas. New gotchas should be added only when encountered and verified in practice.

- **Protomux/RPC registration order**: Register RPC handler BEFORE `store.replicate(conn)`. `store.replicate()` creates a Protomux and immediately processes buffered stream data. If the remote's "open session" message arrives before the protocol handler is registered, Protomux rejects the session → CHANNEL_CLOSED error. Source: registry-implementation-kb.mdc

- **Corestore storage locking**: RocksDB acquires exclusive lock. Each writer needs its own storage directory. Source: registry-implementation-kb.mdc

- **Autobase addWriter/removeWriter**: Only callable from within `apply()` function, not from regular code. Append an operation and handle in apply. Source: registry-implementation-kb.mdc

- **Autobase indexer key access**: Use `indexer.core.key`, not `indexer.key`. Indexer = writer that also materializes the view. Source: registry-implementation-kb.mdc

- **ReadyResource pattern**: Extend `ready-resource` for classes managing resources or state. Implement `_open()` for initialization, `_close()` for cleanup. Source: main.mdc

- **Schema build pipeline order**: Hyperschema first, then HyperDB builder, then Hyperdispatch. All reference `./spec/` directory. Regenerate after schema changes. Source: autopass-knowledge.mdc, registry-implementation-kb.mdc

- **b4a over Buffer**: Use `b4a` (buffer-to-anything) instead of Node.js Buffer for cross-runtime compatibility. Source: Holepunch ecosystem convention, verified in hypercore/autobase code.

## Scope Boundaries

- Project-specific gotchas belong in `.cursor/rules/` within each project, not in this skill
- This skill covers ecosystem-level knowledge and discovery strategy only
- The gotchas section grows from real experience; never fabricate gotchas
