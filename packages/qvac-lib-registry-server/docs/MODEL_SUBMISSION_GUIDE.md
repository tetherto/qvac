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
3. Submit PR

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

## Source URL Formats

- HuggingFace: `https://huggingface.co/<org>/<repo>/resolve/<commit>/<path>`
- S3: `s3://<bucket>/<key>`

Pin to specific commit/version. Avoid `main` or `latest`.

## Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `source` | Yes | Full URL to model file |
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

