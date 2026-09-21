# LLM KV cache

KV-cache behavior is owned by the llama.cpp completion plugin under
`src/plugins/builtin/llamacpp-completion/ops/`, with shared path helpers under
`src/plugins/ops/` and the inference utilities.

- Keep on-disk state, active references, and saved-message bookkeeping under one
  session owner.
- Use the session begin/commit/rollback lifecycle; do not update individual cache
  bookkeeping structures from handlers.
- Serialize writes for one cache identity and keep cache keys portable across
  case-sensitive and case-insensitive filesystems.
- Include every prompt-affecting input in validity decisions and test changes to
  cache identity deterministically.
- Validate a newly written cache before marking it initialized, and roll back
  incomplete state after failure or cancellation.
- Use `deleteCache({ auto: true })` to reclaim inactive auto caches without
  deleting caller-owned named caches; active cache keys remain protected.

Implementation and focused tests are authoritative for the current cache format.
