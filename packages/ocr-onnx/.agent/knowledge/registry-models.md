# QVAC Model Registry — Full Flow

## Overview

The QVAC Model Registry is a distributed, multi-writer system built on **Autobase + HyperDB + Hyperblobs** (Holepunch libraries). It stores model artifacts and metadata, enabling clients to discover and download models via peer-to-peer swarm replication.

---

## Part 1: Adding New Models to the Registry

### Step 1 — Prepare Model Metadata

Models are configured in JSON files on the registry server side (`qvac-lib-registry-server`):
- `data/models.test.json` (test environment)
- `data/models.prod.json` (production)

Each entry includes:
```json
{
  "source": "https://huggingface.co/...",
  "engine": "@qvac/transcription-whispercpp",
  "quantization": "q8_0",
  "params": "tiny",
  "license": "MIT",
  "tags": ["function:transcription", "type:whisper", "name:tiny"]
}
```

Sources can be: HuggingFace URLs, S3 paths, or local files.

### Step 2 — Open a PR

Add/modify entries in `models.prod.json` and open a PR with the `verify` label. GitHub Actions (`.github/workflows/pr-models-validation-qvac-lib-registry-server.yml`) automatically validates JSON structure, licenses, duplicates, and engine format. Models are **not uploaded yet**.

### Step 3 — Merge to `main`

On merge, the same GitHub Action triggers `scripts/sync-models.js` which:
1. Diffs `models.prod.json` against the live registry
2. Downloads new model binaries from source (HuggingFace/S3/local)
3. Uploads them to **Hyperblobs** storage
4. Creates blob pointers (coreKey, blockOffset, blockLength, byteOffset) and inserts metadata into **HyperDB**
5. Updates metadata for existing models, auto-deprecates removed ones

The CI worker authenticates via GitHub Actions secrets (`QVAC_WRITER_PUBLIC_KEY`, `QVAC_WRITER_SECRET_KEY`, `QVAC_AUTOBASE_KEY`).

After sync, `scripts/smoke-test-client.js` verifies the registry is healthy.

Models are now **live in the registry** and queryable via `modelRegistrySearch()`.

**Manual options** also exist: `scripts/add-model.js` (single) and `scripts/add-all-models.js` (bulk) for direct RPC uploads outside CI.

### Step 4 — Update Static Model Constants in the SDK (optional but recommended)

After models are live in the registry, run the update-models script **in the SDK repo**:

```bash
cd packages/sdk
bun run update-models
```

This regenerates `packages/sdk/models/registry/models.ts` — an auto-generated TypeScript file containing compile-time constants for all known models.

Then open a PR to include the updated `models.ts` in the next SDK release.

**Important:** `bun run update-models` is an internal SDK repo tool. It is NOT available to consumers who install the SDK from npm.

#### What `update-models` does internally:
1. Connects to the live registry using `DEFAULT_REGISTRY_CORE_KEY`
2. Calls `client.findModels({})` to fetch all registry entries
3. Deduplicates by SHA256 checksum
4. Generates TypeScript constant names per addon naming strategy (e.g. `OCR_DETECTOR_DB_RESNET50`, `WHISPER_TINY_Q8_0`)
5. Writes `packages/sdk/models/registry/models.ts`
6. Records history in `packages/sdk/models/history/`

#### Related scripts:
```
bun run update-models          # Regenerate models.ts from live registry
bun run check-models           # Check for differences without updating (exit 1 if changes)
bun run check-models:hook      # Same but exit 0 (for pre-commit hooks)
```

#### Flags:
- `--check` — dry run, exits 1 if changes detected
- `--non-blocking` — dry run, always exits 0
- `--show-duplicates` — log details of deduplicated models
- `--no-dedup` — skip deduplication

---

## Part 2: Consuming Models from the Registry

### Option A — Dynamic Search (recommended for new/recently-added models)

Use `modelRegistrySearch()` from the SDK client API. This queries the **live registry** via RPC:

```typescript
import { modelRegistrySearch } from "@qvac/sdk";

// Search by addon type
const ocrModels = await modelRegistrySearch({ addon: "ocr" });

// Search by text
const whisperModels = await modelRegistrySearch({ filter: "whisper" });

// Search by engine
const embedModels = await modelRegistrySearch({ engine: ModelType.llamacppEmbedding });

// Search by quantization
const q4Models = await modelRegistrySearch({ quantization: "q4" });

// Combined search
const q4LlmModels = await modelRegistrySearch({
  engine: ModelType.llamacppCompletion,
  quantization: "q4",
});
```

**Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `filter` | `string` | Text search across name, path, addon, engine (case-insensitive) |
| `engine` | `string` | Filter by engine type (legacy names auto-resolved) |
| `quantization` | `string` | Filter by quantization string |
| `addon` (or `modelType`) | `ModelRegistryEntryAddon` | Filter by addon: `"llm"`, `"whisper"`, `"embeddings"`, `"nmt"`, `"vad"`, `"tts"`, `"ocr"`, `"parakeet"` |

### Option B — Static Constants (fast, no network, but may be stale)

Use the pre-generated constants from the SDK. These are baked in at SDK publish time:

```typescript
import { WHISPER_TINY_Q8_0 } from "@qvac/sdk/models/registry";

const modelSrc = `registry://${WHISPER_TINY_Q8_0.registrySource}/${WHISPER_TINY_Q8_0.registryPath}`;

await loadModel({
  modelSrc,
  modelType: ModelType.whispercppTranscription,
});
```

Helper functions available:
```typescript
import { getModelByName, getModelByPath, getModelBySrc } from "@qvac/sdk/models/registry";

const model = getModelByName("WHISPER_TINY_Q8_0");
const model = getModelByPath("qvac_models_compiled/...");
```

### Option C — Low-Level Registry Client (`findModels` / `findBy`)

From `@qvac/registry-client` (direct Hyperblobs/HyperDB queries):

```typescript
// findBy — simple named filters
const models = await client.findBy({
  name: "whisper",           // partial match, case-insensitive
  engine: "whispercpp",      // exact match
  quantization: "q8",        // partial match, case-insensitive
  includeDeprecated: false,  // default: false
});

// findModels — range queries (advanced)
const shards = await client.findModels({
  gte: { path: "hf/model-" },
  lte: { path: "hf/model-\uffff" },
});
```

### Loading a Model After Discovery

Once you have a model entry (from any method above):

```typescript
const modelSrc = `registry://${model.registrySource}/${model.registryPath}`;

await loadModel({
  modelSrc,
  modelType: model.engine,  // or the appropriate ModelType constant
});
```

The SDK handles:
- Checking local cache
- Direct blob download using blob binding metadata (coreKey, blockOffset, etc.)
- SHA256 validation
- Sharded model assembly
- Companion model downloads (e.g. OCR detector + recognizer pairs)

---

## Key Difference: `findModels({})` vs `modelRegistrySearch()`

| | `findModels({})` / static constants | `modelRegistrySearch()` |
|---|---|---|
| **Source** | Static `models.ts` baked into SDK package | Live registry query via RPC |
| **New models** | Only after `update-models` + SDK republish | Immediately available |
| **Network** | No network call needed (for constants) | Requires active registry connection |
| **Use case** | Known models, offline-first | Discovering new/recently-added models |

If newly uploaded models are not showing up via static constants or `findModels({})`, use `modelRegistrySearch()` to query the live registry directly. The static constants only get updated when `bun run update-models` is run in the SDK repo and a new version is published.

---

## QVAC_REGISTRY_CORE_KEY

- **What:** A z-base-32 encoded Hypercore discovery key pointing to the HyperDB core containing registry metadata
- **Default value:** `uf1fm44uzockp6azhcdiqt1esjgm65fwtimsh946e8kwysdes9ko`
- **Defined in:** `packages/sdk/constants/registry.ts`
- **Override:** Set `QVAC_REGISTRY_CORE_KEY` environment variable
- **When to update:** Only if the registry server is re-initialized with a new Autobase key (rare). Normal model additions do NOT require updating this key.

---

## Key File Locations

| Component | Path |
|-----------|------|
| Registry core key constant | `packages/sdk/constants/registry.ts` |
| Static models (auto-generated) | `packages/sdk/models/registry/models.ts` |
| Update-models script | `packages/sdk/models/update-models/index.ts` |
| Naming strategy | `packages/sdk/models/update-models/naming.ts` |
| Code generation | `packages/sdk/models/update-models/codegen.ts` |
| History tracking | `packages/sdk/models/update-models/history.ts` |
| Client API (modelRegistrySearch) | `packages/sdk/client/api/registry.ts` |
| Server RPC handlers | `packages/sdk/server/rpc/handlers/registry.ts` |
| Load-model registry handler | `packages/sdk/server/rpc/handlers/load-model/registry.ts` |
| Registry client wrapper | `packages/sdk/server/bare/registry/registry-client.ts` |
| Engine-to-addon mapping | `packages/sdk/schemas/engine-addon-map.ts` |
| Registry schemas | `packages/sdk/schemas/registry.ts` |
| Registry query example | `packages/sdk/examples/registry-query.ts` |
| Registry server README | `packages/qvac-lib-registry-server/README.md` |
| Registry client README | `packages/qvac-lib-registry-server/client/README.md` |

---

## Quick Reference: End-to-End Flow

```
1. Configure model in models.prod.json
2. Upload via registry server RPC (add-model / add-all-models)
3. PR merged → models live in registry
4. Consumer apps: use modelRegistrySearch() to find new models immediately
5. SDK maintainers: run `bun run update-models` → PR to update static constants
6. Next SDK release includes new model constants for offline/fast access
```
