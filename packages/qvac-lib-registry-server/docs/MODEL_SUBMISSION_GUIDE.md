# Model Submission Guide

## Adding a New Model

1. Add entry to `data/models.prod.json`:
   ```json
   {
     "source": "https://huggingface.co/<org>/<repo>/resolve/<commit>/<file>",
     "engine": "@qvac/<engine-name>",
     "licenseId": "MIT",
     "quantization": "q4_0",
     "params": "1B",
     "tags": ["generation", "instruct"],
     "description": "",
     "notes": "",
     "link": "https://huggingface.co/<org>/<repo>"
   }
   ```

2. If the model uses a license not already in `data/licenses.json`, add a new entry there and place the full license text at `data/licenses/<license-id>/LICENSE.txt`.
3. Run validation: `npm run validate:models`
4. Submit PR targeting `main`

### Source URL Formats

- HuggingFace: `https://huggingface.co/<org>/<repo>/resolve/<commit>/<path>`
- S3: `s3:///<key>` (bucket name is resolved from `QVAC_S3_BUCKET` environment variable)

**HuggingFace URLs must use a full 40-character commit SHA** — branch names like `main` or `master` are rejected by the validation script. To get the commit SHA, open the repo on HuggingFace, copy the latest commit hash from the commit history, and use it in place of `main`:

```
# Wrong — points to a branch, will break if the repo is updated
https://huggingface.co/org/repo/resolve/main/model.gguf

# Correct — pinned to an immutable commit
https://huggingface.co/org/repo/resolve/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/model.gguf
```

The S3 bucket name is **not** stored in `models.prod.json`. Set `QVAC_S3_BUCKET` in your `.env` file.
The server resolves the bucket at runtime when downloading artifacts.

### S3 Date Folder Requirement

S3 source paths **must** include a date folder (`YYYY-MM-DD`) identifying when the artifact was uploaded:

```
s3:///qvac_models_compiled/<type>/<model-name>/<YYYY-MM-DD>/<filename>
```

Example:
```
s3:///qvac_models_compiled/ggml/Llama-3.2-1B/2025-12-04/Llama-3.2-1B-Instruct-Q4_0.gguf
```

**Why**: The registry tracks models by their source URL. If a model binary is replaced at the same S3 path, the registry has no way to detect the change — checksums, file sizes, and content become inconsistent without any visible update. Dated directories guarantee each version has a unique path. When updating a model, upload the new version to a new date folder and submit a new registry entry (deprecating the old one if needed).

The validation script enforces this for all new S3 entries. Legacy paths predating this rule are listed in `data/s3-legacy-paths.json`.

### Registry Sync Process

The staging registry syncs **automatically on merge to `main`**. No manual labels required.

1. Submit PR targeting `main` with `models.prod.json` changes.
2. Ensure validation passes (the `validate-json` job runs on PRs with the `verify` label).
3. Once approved, merge to `main`. The `sync-staging` pipeline triggers automatically on push to `main` when `models.prod.json` is modified.

How sync works:

- The sync process compares the full `models.prod.json` against the current database state and applies **all** differences — not just changes from the current PR. If a previous PR was merged without triggering a sync, its changes will be included in the next sync run.
- A `workflow_dispatch` trigger is available for manual sync when needed.

## Deprecating a Model

Add deprecation fields to existing entry:
```json
{
  "source": "...",
  "deprecated": true,
  "replacedBy": "<full-source-url-of-replacement>",
  "deprecationReason": "Superseded by v2"
}
```

The `replacedBy` field must reference a model that exists in the same JSON file. The sync script will automatically set `deprecatedAt` timestamp when deprecating.

## Undeprecating a Model

To reverse a deprecation (e.g., deprecated by mistake), set `deprecated: false`:
```json
{
  "source": "...",
  "deprecated": false
}
```

The sync script will clear all deprecation fields (`deprecatedAt`, `replacedBy`, `deprecationReason`) automatically.

## Removing a Model

**Default**: Deprecate the model (see above) rather than removing it from the JSON file.

If you remove an entry from `models.prod.json`, the sync script will auto-deprecate it in the database with reason "Removed from configuration". The model data is preserved.

**For permanent deletion**: Create a ticket with the reason for deletion. Manual intervention required.

## Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `source` | Yes | URL to model file (`https://huggingface.co/...` or `s3:///key`) |
| `engine` | Yes | Engine identifier (e.g., `@qvac/llm-llamacpp`) |
| `licenseId` | Yes | License identifier matching an entry in `data/licenses.json` |
| `quantization` | No | Quantization format (e.g., `q4_0`, `q8_0`) |
| `params` | No | Model parameter count (e.g., `1B`, `4B`) |
| `description` | No | Human-readable description |
| `notes` | No | Additional notes |
| `tags` | No | Array of tag strings |
| `link` | No | URL to the model's HuggingFace page or project. Required for S3-hosted models to provide traceability back to the original source. |
| `deprecated` | No | Boolean flag for deprecation |
| `replacedBy` | No | Source URL of replacement model |
| `deprecationReason` | No | Reason for deprecation |

Note: `deprecatedAt` timestamp is auto-generated when syncing to the database.

### License Files

Each license used in `models.prod.json` must have:

1. An entry in `data/licenses.json` with `spdxId`, `name`, and `url`.
2. A full license text at `data/licenses/<spdxId>/LICENSE.txt`.

Existing licenses: `Apache-2.0`, `MIT`, `llama3.2`, `gemma`, `health-ai-developer-foundations`, `MPL-2.0`, `CC-BY-4.0`, `openrail`.

When adding a model with a new license, include the license file in the same PR.

