# SDK wire contract

Language-neutral description of the SDK server's RPC surface, generated from
the Zod schemas and the method registry. Generated clients are built from
these artifacts.

- `schema.json` — JSON Schema (draft 2020-12) for every request and response
  wire type, plus every public constant registered in `@/schemas/constants-
registry` (`ModelType`, `ToolsMode`, `Verbosity`, `PluginId`,
  `SupportedAudioFormat`) as its own `constants.<Name>` def, tagged with
  `x-enum-varnames` so codegen preserves the original key names (plain JSON
  Schema `enum:` only carries values). Requests use the schema input shape,
  responses the output shape; runtime-only refinements and transforms stay
  server-side. See `.cursor/rules/sdk/public-constants-contract.mdc` for
  what must be registered to reach `schema.json` at all.
- `manifest.json` — every RPC method with its call shape (`request-reply`,
  `server-stream`, `duplex`) and pointers into `schema.json`.
- `models.json` — every named model registry constant (`QWEN3_600M_INST_Q4`,
  ...) from `@/models/registry`, the same constants JS consumers import
  directly and pass as `modelSrc`. Not part of the RPC wire contract, but a
  static data catalog downstream client generators need the same way.

Do not edit these files by hand. Regenerate with:

```bash
bun run contract:export
```

`bun run contract:check` exits non-zero when the artifacts are stale;
`test/unit/contract-export.test.ts` enforces the same in `test:unit`.

## Naming nested/inline schemas

Every request/response def gets a `title` (`LoadModelRequest`, ...) derived
from its method name, and the exporter also titles nested/inline schemas
automatically — by property path, and for discriminated union arms, by the
arm's actual discriminator value (`CompletionStreamResponseEventsItemToolCall`,
not `Events3`).

When a union arm has no usable discriminator (e.g. `finetune`'s run/getState/
stop request shapes, distinguished by which fields are present rather than by
a shared const), the exporter falls back to a plain positional name. If the
underlying Zod schema already has its own meaningful identity in the source
(a separately named `const ...Schema`), give it an explicit title instead —
the exporter always defers to one already present:

```ts
export const finetuneRunRequestSchema = finetuneRunParamsSchemaBase
  .extend({ ... })
  .meta({ title: 'FinetuneRunRequest' })
```

Don't do this for schemas that are shared, generic building blocks reused
across many unrelated fields (e.g. `modelSrcInputSchema`'s "string or
descriptor object" pattern, reused by a dozen different `modelConfig` fields)
— a single shared title there would be less useful than the exporter's
per-field derived name, which tells you which field it's for.

## Progress responses

4 methods — `loadModel`, `downloadAsset`, `rag`, `finetune` — can switch from
a plain unary reply to a stream of responses when the caller opts in
(`request.withProgress === true`): progress events and the final reply both
arrive as stream frames, distinguished only by each payload's own `type`
field, not by frame position. `manifest.json` marks these 4 methods with a
`progress` block:

```json
"progress": {
  "condition": "request.withProgress === true",
  "responseSchema": "schema.json#/$defs/rag:progress.response"
}
```

`rag` and `finetune` gate progress on the request's `operation` in addition to
`withProgress` — a consumer that only checks `withProgress` would wrongly
expect progress frames for operations that never emit them. `condition`
spells out the full check, e.g. `rag`'s is:

```
request.withProgress === true && ['ingest', 'saveEmbeddings', 'reindex'].includes(request.operation)
```

`downloadAsset` has no progress schema of its own — it reuses `loadModel`'s
(`modelProgress.response`), since both stream the same underlying
model-fetch progress.
