# Error handling

The SDK has two error responsibilities:

- `src/utils/errors-client.ts` owns failures produced by the Node, Electron, Expo,
  and RPC client layer.
- `src/utils/errors-server.ts` owns SDK worker failures that are not already owned
  and exported by `@qvac/inference`.

The corresponding code registries are under `src/schemas/`. Treat those registries,
the inference error surface, and the tests as authoritative for current classes and
codes; do not copy their inventories into documentation.

## Rules

- Throw the narrowest structured error available at the layer that detects the
  failure. Do not use a generic `Error` for a defined SDK failure mode.
- Preserve `cause` when translating an error and include only safe, serializable
  context in error metadata.
- Keep client and worker/inference errors separate. Re-export an inference error
  instead of defining an SDK duplicate.
- When an error crosses RPC, update reconstruction, serialization, schema, public
  export, and focused round-trip tests together.
- Error messages help a caller act; they do not expose credentials, private paths,
  or infrastructure details.

Read the constructors and neighboring tests before changing call sites. They define
the accepted options shape and compatibility behavior.
