# SDK wire contract

Language-neutral description of the SDK server's RPC surface, generated from
the Zod schemas and the method registry. Generated clients are built from
these artifacts.

- `schema.json` — JSON Schema (draft 2020-12) for every request and response
  wire type. Requests use the schema input shape, responses the output shape;
  runtime-only refinements and transforms stay server-side.
- `manifest.json` — every RPC method with its call shape (`request-reply`,
  `server-stream`, `duplex`) and pointers into `schema.json`.

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
