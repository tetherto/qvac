# Cache lifecycle

How the addon-owned prompt cache behaves end to end: what is stored where, how
a request is reconciled with what is resident, when it commits or rolls back,
and what the process-local checkpoints do on models that cannot trim their
memory. For the API surface (`cacheKey`, `saveCacheToDisk`, `prefill`) see
[cache-api.md](./cache-api.md); this page explains the machine behind it.

## The pieces

```mermaid
graph TB
    subgraph Client
        HIST["Full message history + tools<br/>(resent on every turn)"]
    end

    subgraph "Addon, per sequence"
        LEDGER["Ledger (RAM)<br/>one entry per resident token / media span"]
        KV["Sequence memory (GPU / RAM)<br/>KV cells, recurrent state"]
        SNAP["Pre-request snapshot<br/>full-state models only<br/>lives for one request"]
        CKPT["Process-local checkpoints<br/>full-state models only<br/>≤ cache_checkpoints, ≤ cache_checkpoints_max_bytes"]
    end

    subgraph "Storage chosen by cache_checkpoint_storage"
        TMPD["OS temp directory<br/>(disk, default)"]
        HRAM["Host RAM<br/>(memory)"]
    end

    subgraph "Durable"
        FILE["cacheKey file<br/>sequence state + ledger"]
    end

    HIST -->|render + tokenize| LEDGER
    LEDGER <-->|describes| KV
    KV -->|begin of cached request| SNAP
    SNAP -->|commit| CKPT
    SNAP -->|rollback: restore| KV
    CKPT -->|divergent history: restore newest prefix| KV
    SNAP -.-> TMPD
    SNAP -.-> HRAM
    CKPT -.-> TMPD
    CKPT -.-> HRAM
    KV -->|saveCacheToDisk on commit,<br/>key switch, key omitted| FILE
    FILE -->|cacheKey not resident| KV
```

- The **ledger** is the addon's description of what the sequence memory holds.
  It is compared against the newly rendered prompt to find the longest shared
  prefix, and it is serialized into the `cacheKey` file next to the state.
- The **sequence memory** is llama.cpp's own KV cache and, on hybrid or
  recurrent models, the recurrent state. It is the conversation.
- The **pre-request snapshot** and the **checkpoints** exist only on models
  that cannot trim their memory (see below). Pure-attention models never
  create either, in any storage mode.
- The **`cacheKey` file** is the only durable artifact. Checkpoints are never
  written into it and do not survive a process restart.

## Two kinds of models

| | Pure attention (Qwen3, Llama, Gemma, ...) | Full-state (Qwen3.5, Jamba, Granite-Hybrid, DeepSeek V4, ...) |
|---|---|---|
| Can drop a memory tail at a position | yes, `llama_memory_seq_rm` | no |
| Reuse of a diverging history | trim to the shared prefix, decode the rest | restore the newest checkpoint that is a prefix, decode the rest; cold prefill if none |
| Pre-request snapshot | never | at the start of every cached request |
| Checkpoints | never | one per committed cached request |
| Rollback target | shared prefix with the request's prompt | state before the prompt was sent (the snapshot) |
| Disk writes for a chat with one `cacheKey` and no `saveCacheToDisk` | none | none with `cache_checkpoint_storage: memory`, temp files otherwise |

The decision is `needsFullStateSnapshot` in `ModelMemoryPolicy.hpp`: recurrent
or hybrid per llama.cpp, or the DeepSeek V4 architecture.

## A cached request

```mermaid
stateDiagram-v2
    [*] --> Begin: run() with cacheKey
    Begin --> Reconcile: full-state model: take pre-request snapshot
    Reconcile --> Prefill: decode the suffix after the shared prefix
    Prefill --> Committed: prefill-only request
    Prefill --> Generation: prefill complete
    Prefill --> RolledBack: cancel during prefill<br/>decode error
    Generation --> Committed: EOS · antiprompt · n_predict<br/>cancel after prefill completed
    Generation --> RolledBack: decode error<br/>context overflow
    Committed --> Saved: saveCacheToDisk
    Committed --> [*]: no save requested
    Saved --> [*]
    RolledBack --> [*]: file untouched

    state Committed {
        [*] --> KeepTokens
        KeepTokens: prompt + generated tokens stay resident
        KeepTokens --> PushCheckpoint: full-state model
        PushCheckpoint: snapshot becomes a checkpoint
    }
    state RolledBack {
        [*] --> Drop
        Drop: drop everything this request added
        Drop --> TrimTail: pure attention
        Drop --> RestoreSnapshot: full-state model
    }
```

The rule is the same with or without `cacheKey`. Without one nothing reuses
the state, so the only visible effect is `CacheTokens`, which reports the
tokens actually decoded.

## Reconciling the new prompt with the resident ledger

```mermaid
flowchart TD
    A[Render full history once<br/>compare with resident ledger] --> B{shared prefix?}
    B -->|covers the whole resident ledger| C[Append only:<br/>decode the new suffix]
    B -->|covers the whole new prompt| D[Full match:<br/>back up one token so the last<br/>prompt token is decoded again<br/>and produces logits]
    B -->|ends inside the resident ledger| E{model type}
    E -->|pure attention| F[Trim memory after the prefix<br/>rollback target = prefix<br/>decode the suffix]
    E -->|full-state| G{newest checkpoint that is<br/>a prefix of the new prompt?}
    G -->|found| H[Restore it<br/>decode from there]
    G -->|none| I[Cold: clear the sequence<br/>decode the whole prompt]
    D --> E
```

On a full-state model the back-up-one step of a full match also goes through
the checkpoint search, because one token cannot be trimmed. A "regenerate"
therefore restores the checkpoint taken before the previous prompt and decodes
that prompt again.

After every divergence, checkpoints that are no longer a prefix of the new
prompt are deleted.

## Checkpoint lifecycle (full-state models)

```mermaid
stateDiagram-v2
    [*] --> Snapshot: cached request begins<br/>copy of the sequence state<br/>(disk or memory)
    Snapshot --> Checkpoint: request commits
    Snapshot --> [*]: request rolls back<br/>restored into memory, then dropped
    Checkpoint --> Restored: later prompt diverges and<br/>this is the newest matching prefix
    Restored --> Checkpoint: stays in the list
    Checkpoint --> [*]: pruned, no longer a prefix<br/>of a later prompt
    Checkpoint --> [*]: evicted, oldest first,<br/>when the list exceeds<br/>cache_checkpoints_max_bytes<br/>or cache_checkpoints
    Checkpoint --> [*]: cacheKey switched, cleared or loaded
    Checkpoint --> [*]: process exits
```

Eviction checks the byte budget first, then the count. A budget that cannot
hold `cache_checkpoints` checkpoints of the largest size the context allows is
rejected at model load with `InvalidArgument`; the addon measures that size on
the loaded model rather than estimating it.

## The `cacheKey` file

```mermaid
stateDiagram-v2
    [*] --> Absent
    Absent --> Written: committed request with saveCacheToDisk
    Resident --> Written: committed request with saveCacheToDisk<br/>switch to another cacheKey<br/>request without cacheKey
    Written --> Resident: next request with the same cacheKey<br/>while the process lives
    Written --> Loaded: request with the cacheKey<br/>after a restart or a key switch
    Loaded --> Resident
    Written --> Rejected: current-format file with a corrupt ledger<br/>UnableToLoadSessionFile
    Written --> Cold: legacy file without a ledger<br/>treated as a miss
    Resident --> Resident: committed request without saveCacheToDisk<br/>(memory advances, file does not)
    Resident --> Resident: rolled-back request<br/>(file untouched)
```

Loading a file restores the sequence state and the ledger, with an empty
checkpoint list. The first diverging turn after a restart on a full-state model
is therefore a cold prefill until new checkpoints accumulate.

## Configuration that shapes the machine

| Setting | Where | Effect |
|---|---|---|
| `cacheKey` | `runOptions` | Turns the cache on for this sequence and names the durable file. |
| `saveCacheToDisk` | `runOptions` | Write the file when this request commits. |
| `prefill` | `runOptions` | Warm the cache without generating; commits as soon as prefill completes. Needs `saveCacheToDisk` on `parallel >= 2`. |
| `cache_checkpoints` | load config | Checkpoints kept per sequence (default 32, 0 disables). Full-state models only. |
| `cache_checkpoints_max_bytes` | load config | Byte budget for those checkpoints, enforced before the count; fails the load early if too small. |
| `cache_checkpoint_storage` | load config | `disk` (temp files) or `memory` (host RAM) for snapshots and checkpoints. |
| `parallel` | load config | With `>= 2` each request runs in a slot that is wiped afterwards; cache state survives between requests only through the file. |

## Where each thing lives, at a glance

| | Pure attention | Full-state, `disk` | Full-state, `memory` |
|---|---|---|---|
| Conversation state | sequence memory | sequence memory | sequence memory |
| Ledger | RAM | RAM | RAM |
| Pre-request snapshot | none | temp file, one per running request | host RAM, one per running request |
| Checkpoints | none | temp files | host RAM |
| `cacheKey` file | only on the three saves | only on the three saves | only on the three saves |
