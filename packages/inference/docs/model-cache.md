# Model cache

The public cache and lifecycle operations are implemented by the API, handler,
schema, and runtime modules under `src/`. `@qvac/sdk` exposes corresponding client
operations over its worker transport.

- Treat model descriptors and normalized source identifiers as identities, not only
  raw URLs.
- Preserve download deduplication and subscriber-aware cancellation when changing
  asset retrieval.
- Keep cache paths within the configured cache root and validate destructive cache
  targets before deleting them.
- Model loading and unloading are explicit lifecycle operations. Do not add implicit
  eviction or teardown without a public contract decision.
- Update schemas, both in-process and SDK transport callers, and focused tests when
  changing a cache-management response.

A GGUF downloaded with its Core ML bundle on macOS or iOS uses the
`sets/<setKey>/` companion-set layout: the GGUF and the `.mlmodelc` directory sit
side by side, with a metadata file that lets a later load reopen the set without
registry access. When that GGUF is the loaded model's primary file,
`clearStorage` removes the whole set, bundle included. A GGUF loaded without a
bundle uses its ordinary single-file cache path.

The current schemas and handlers are authoritative for supported fields and model
types. Do not maintain a second field inventory here.

## Shared models directory

Several engine processes can share one models directory, for example an app,
`qvac sdk serve` and a TUI. The download manager joins downloads only within one
process, so downloads are also coordinated on disk:

- A download writes to `<file>.part` beside its final path and is renamed into
  place only after its size and checksum checks pass. A file at a model path is a
  complete download, and a `.part` file is never read as a cached model. HTTP
  downloads resume from the `.part` file; registry and Hyperdrive downloads
  rewrite it from the blocks they already stored.
- Each download holds an OS file lock under `<models directory>/.locks/`, named
  after the cache resource it writes: the registry path for registry downloads,
  the source for HTTP and Hyperdrive. A process asking for the same model waits,
  then finds the model through its normal cache check. The OS releases the lock
  when the holder exits. Cancelling while waiting deletes nothing. A read-only
  models directory takes no lock, so its cached models still load.
- Cache checks never delete a mismatched file; the download that follows
  replaces it. Cancelling with `clearCache` deletes only the partial file, or the
  shard or companion-set directory, that the cancelled download was writing
  while it held the lock.
- `deleteCache` for a registry model takes the same locks without waiting. It is
  refused while another process downloads the model or a model sharing its files,
  and downloads in other processes wait while it deletes.
- Engines released before this layout write in place and take no lock. Sharing a
  models directory with one is safer than before but not fully protected.

## Integrity verification reuse

Registry and Hyperdrive artifact checks reuse SHA-256 digests within the engine
process, including companion files and shards. Reuse requires an unchanged
absolute path, device, inode, size, modification time, and change time. Missing,
modified, truncated, or replaced files invalidate reuse; every check still compares
against the requested checksum. When usable identity metadata is available,
verification rejects files whose metadata changes during hashing. Filesystems
without usable identity metadata are always hashed. Moving a verified `.part`
file into place keeps its digest when the file is unchanged since it was hashed,
because the rename itself can update the change time.
The digest cache is bounded and is not persisted: the first verification after a
process restart reads the file again. HTTP cache freshness behavior is unchanged.
This detects filesystem-visible changes; detecting silent corruption that leaves
all file metadata unchanged requires a fresh hash (for example after restart).
