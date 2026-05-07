---
name: holepunch-dev
description: Guides discovery and development with Holepunch ecosystem libraries. Use when working with P2P stack (Hypercore, Hyperswarm, Autobase, Hyperdb, Corestore), Bare runtime (bare-* modules like bare-fs), or Pear app framework (pear-* modules). Teaches on-the-fly API discovery via docs.pears.com and gh CLI.
---

# Holepunch Development

Ecosystem navigator for Holepunch/Bare/Pear development. Teaches the agent to discover APIs on-the-fly rather than carrying static knowledge dumps.

## Canonical Index: docs.pears.com

`https://docs.pears.com` is the curated, always-current index for the entire ecosystem. Prefer it over any static list in this skill. Relevant anchors:

- `#p2p-modules` — Building-block libraries (hypercore, hyperbee, hyperdrive, autobase, hyperdht, hyperswarm) and helpers (corestore, localdrive, mirror-drive, secret-stream, compact-encoding, protomux).
- `#bare-modules` — All `bare-*` runtime modules with stability indicators and platform support. Most are Node.js standard-library equivalents (`bare-fs` ≈ `fs`, `bare-crypto` ≈ `crypto`, `bare-tcp` ≈ `net`, `bare-subprocess` ≈ `child_process`). Node.js-compat shims live in `bare-node`.
- `#pear-modules` — `pear-*` modules grouped by role (Application, UI, Common, Developer, Integration). Largest surface: `pear-electron` (100+ methods for desktop UI — fetch its README). Lifecycle commands: `pear init/run/stage/seed/release`.

## P2P Stack by Purpose

docs.pears.com groups P2P libraries as "building-block vs helper". This table groups by **purpose** and includes libraries used widely across Holepunch-based applications (Keet, PearPass/autopass, QVAC registry-server, WDK, etc.) that are **not** on the docs.pears.com index page:

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

Repo-name anomaly: `@hyperswarm/secret-stream` ships from the `holepunchto/hyperswarm-secret-stream` repo.

## Discovery Playbook

When you need to learn about a Holepunch library, follow these steps in order. Do not stop at the first source if the API surface is still unclear.

### Step 1: docs.pears.com

Navigation hub and canonical module index. How-to guides contain working executable examples.

- Module index: https://docs.pears.com/ (see anchors above)
- Building blocks overview: https://docs.pears.com/index.html#building-blocks
- How-tos (real code):
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

When README is insufficient, read `index.js` or `lib/` directly:

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

**Policy: Only document verified facts.** Each gotcha below is observed in real Holepunch-based production systems and re-verifiable via the Discovery Playbook (upstream README, tests, and source). Do not invent or speculate. Add new gotchas only when encountered and verified in practice.

- **Protomux/RPC registration order**: Register RPC handler BEFORE `store.replicate(conn)`. `store.replicate()` creates a Protomux and immediately processes buffered stream data. If the remote's "open session" message arrives before the protocol handler is registered, Protomux rejects the session → CHANNEL_CLOSED error.

- **Corestore storage locking**: RocksDB acquires an exclusive lock per directory. Each writer needs its own storage path.

- **Autobase addWriter/removeWriter**: Only callable from within `apply()`, not from regular code. Append an operation and handle it in apply.

- **Autobase indexer key access**: Use `indexer.core.key`, not `indexer.key`. An indexer is a writer that also materializes the view.

- **ReadyResource pattern**: Extend `ready-resource` for classes managing resources or state. Implement `_open()` for initialization and `_close()` for cleanup.

- **Schema build pipeline order**: Hyperschema first, then HyperDB builder, then Hyperdispatch. All reference the `./spec/` directory. Regenerate after schema changes.

- **b4a over Buffer**: Use `b4a` (buffer-to-anything) instead of Node.js Buffer for cross-runtime compatibility.

## Scope Boundaries

- Static content in this skill is limited to **non-fetchable knowledge**: the QVAC-oriented P2P taxonomy (extends docs.pears.com with libraries QVAC uses), repo-name anomalies, composition patterns across multiple libraries, and verified production gotchas. Anything discoverable via docs.pears.com or a single `gh api` README fetch does not belong here.
- Project-specific gotchas belong in a project-scoped skill (e.g. `.cursor/skills/registry-autobase-patterns/`) or `.cursor/rules/<project>/`, not in this skill.
- This skill covers ecosystem-level knowledge and discovery strategy only.
- If a section starts looking like a paraphrase of an upstream README or the docs.pears.com index, delete it.
