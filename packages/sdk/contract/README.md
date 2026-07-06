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
