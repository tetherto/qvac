# Model Submission Guide

## Adding a New Model

1. Add entry to `data/models.prod.json`:
   ```json
   {
     "source": "https://huggingface.co/<org>/<repo>/resolve/<commit>/<file>",
     "engine": "@qvac/<engine-name>",
     "license": "MIT",
     "quantization": "q4_0",
     "params": "1B",
     "tags": ["generation", "instruct"],
     "description": "",
     "notes": ""
   }
   ```

2. Run validation: `npm run validate:models`
3. Submit PR targeting `main`

### Source URL Formats

- HuggingFace: `https://huggingface.co/<org>/<repo>/resolve/<commit>/<path>`
- S3: `s3:///<key>` (bucket name is resolved from `QVAC_S3_BUCKET` environment variable)

Pin to specific commit/version. Avoid `main` or `latest`.

The S3 bucket name is **not** stored in `models.prod.json`. Set `QVAC_S3_BUCKET` in your `.env` file.
The server resolves the bucket at runtime when downloading artifacts.

### Registry Sync Process

After the PR is created:

1. Add the **"staging"** label to the PR. This triggers the `sync-staging` pipeline that applies changes to the staging registry.
2. Wait for the `sync-staging` pipeline to pass. **Do not merge the PR if the pipeline fails** — fix the issue first.
3. Once the pipeline passes and the PR is approved, merge to `main`.

How sync works:

- The sync process compares the full `models.prod.json` against the current database state and applies **all** differences — not just changes from the current PR. If a previous PR was merged without triggering a sync, its changes will be included in the next sync run.
- If a PR is merged without the "staging" label (i.e., without triggering a sync), the changes are not lost. They will be applied the next time a sync is triggered by another PR.

**Important**: For now, notify **@yuri.samarin** directly when submitting changes to `models.prod.json` so he can assist with the sync process.

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
| `license` | Yes | SPDX license identifier |
| `quantization` | No | Quantization format (e.g., `q4_0`, `q8_0`) |
| `params` | No | Model parameter count (e.g., `1B`, `4B`) |
| `description` | No | Human-readable description |
| `notes` | No | Additional notes |
| `tags` | No | Array of tag strings |
| `deprecated` | No | Boolean flag for deprecation |
| `replacedBy` | No | Source URL of replacement model |
| `deprecationReason` | No | Reason for deprecation |

Note: `deprecatedAt` timestamp is auto-generated when syncing to the database.

## Common Issues

### Concurrent PRs auto-deprecate each other's models

The sync-staging pipeline compares the **entire** `models.prod.json` from the PR branch against the current database state. If two PRs that modify `models.prod.json` are open at the same time:

1. PR-A adds models X. Sync runs on PR-A → models X are synced to the staging database.
2. PR-B (branched before PR-A) does not contain models X. Sync runs on PR-B → models X are missing from its `models.prod.json`, so the sync script auto-deprecates them as "Removed from configuration".

**Workaround**: Merge model PRs sequentially. Before triggering sync-staging on your PR, ensure no other `models.prod.json` PR has unmerged synced changes in the database. If models were incorrectly auto-deprecated, undeprecate them (see [Undeprecating a Model](#undeprecating-a-model)) or rebase your branch onto the latest `main` and re-run the sync.

