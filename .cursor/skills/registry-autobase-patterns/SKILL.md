---
name: registry-autobase-patterns
description: Reference material for Autobase, HyperDB, and multi-writer patterns in the QVAC registry server. Use when working with Autobase, HyperDB schemas, blind pairing/peering, Hyperdispatch, or debugging Corestore/replication issues.
---

# Registry Autobase Patterns

## What

Reference material for Autobase, HyperDB, Hyperdispatch, and multi-writer distributed database patterns used in the QVAC registry server. Covers schema design, blind pairing/peering, multi-writer deployment, RPC layer setup, and HyperDB query patterns.

## When to Use

- Working with Autobase configuration, apply functions, or multi-writer patterns
- Working with HyperDB schemas, collections, indexes, or query patterns
- Implementing or debugging blind pairing (invites) or blind peering (mirrors)
- Setting up Hyperdispatch routers or operation encoding
- Deploying or managing multi-writer instances (3-writer setup, writer rotation)
- Working with Hyperswarm networking, Protomux RPC, or peer discovery
- Debugging Corestore, Hypercore, or replication issues

## References

| File | Content |
|------|---------|
| `references/autobase-patterns.md` | Autobase + HyperDB multi-writer architecture: blind pairing, blind peering, schema build pipeline, router setup, common operations |
| `references/implementation-kb.md` | Registry-specific gotchas: Corestore locking, named keypairs, writer vs indexer, Protomux connection order |
| `references/hyperdb-learnings.md` | HyperDB workshop: schema definition, CRUD operations, indexes, query patterns, networking, testing |
| `references/hyperdb-autobase-learnings.md` | Multi-writer workshop: Autobase architecture, Hyperdispatch, RPC layer, 3-writer deployment, disaster recovery |
