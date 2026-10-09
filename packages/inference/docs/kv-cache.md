# LLM KV cache

KV-cache behavior is owned by the llama.cpp completion plugin under
`src/plugins/builtin/llamacpp-completion/ops/`, with shared path helpers under
`src/plugins/ops/` and the inference utilities.

- Send the whole conversation and the tools on every turn, cached or not. The
  addon compares the rendered prompt with the tokens the cache file holds and
  decodes only what follows the shared prefix, so the plugin keeps no record of
  what a file covers.
- Keep on-disk state and active references under one session owner.
- Use the session begin/commit/rollback lifecycle; do not update individual cache
  bookkeeping structures from handlers.
- Serialize writes for one cache identity and keep cache keys portable across
  case-sensitive and case-insensitive filesystems.
- Name a cache file by key and system prompt only. A changed tool set or an
  edited history must reach the same file so the addon can trim it at the
  divergence point.
- Write every turn's cache with `saveCache` once the run finishes. The addon
  otherwise keeps it in memory, and the session, the auto-cache rename and a
  restart all read the file.
- Validate a newly written cache before marking it initialized. The addon
  commits or rolls back a cancelled or failed request itself (a cancel after
  prefill keeps the prompt and the tokens streamed so far), so keep the file
  rather than deleting it; only an auto cache with no key to move to is
  dropped, and the addon's copy of the conversation goes with the file.
- Use `deleteCache({ auto: true })` to reclaim inactive auto caches without
  deleting caller-owned named caches; active cache keys remain protected.

Implementation and focused tests are authoritative for the current cache format.
