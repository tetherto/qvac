# qvac (Python)

Generated Python client for the QVAC SDK's worker RPC.

## What's generated, and from what

`src/qvac/_generated/` is regenerated from `../sdk/contract/{schema,manifest}.json`
(the TypeScript SDK's own generated contract — see `packages/sdk/contract/README.md`):

- `_generated/models/` — pydantic v2 models for every request/response, produced
  by [`datamodel-code-generator`](https://github.com/koxudaxi/datamodel-code-generator)
  from `schema.json`.
- `_generated/__init__.py` — a flat, stable re-export of every model under its
  contract title (`LoadModelRequest`, `HeartbeatResponse`, ...), regardless of
  which internal module `datamodel-code-generator` happened to place it in.
- `_generated/methods.py` — one typed async function per `manifest.json` entry,
  grouped by call shape:
  - `request-reply` → `async def heartbeat(transport, params: HeartbeatRequest) -> HeartbeatResponse`
  - `server-stream` → `async def transcribe(transport, params: TranscribeRequest) -> AsyncIterator[TranscribeResponse]`
  - `duplex` → `async def transcribe_stream(transport, params: TranscribeStreamRequest, up: AsyncIterable[bytes]) -> AsyncIterator[TranscribeStreamResponse]`
  - Constant enums (`ModelType`, `PluginId`, ...) come through `qvac.schemas` too, alongside the
    request/response models.

Regenerate with:

```bash
python3 scripts/generate.py
```

`python3 scripts/generate.py --check` exits non-zero when the committed output
is stale; `tests/test_generate.py` enforces the same via pytest.

## What's NOT generated: the transport

Every stub takes a `transport: Transport` (`src/qvac/_transport.py`) — a
`Protocol` with `call`/`call_stream`/`call_duplex`. This package does not
implement the actual `bare-rpc` socket transport that speaks to the SDK
worker; that's a separate, not-yet-built piece (QVAC's "Transport integration
(bare-rpc-python)" task). Anything implementing the `Transport` protocol can
back the generated stubs — see `tests/poc_transport.py` for a minimal adapter
over a hand-written PoC transport, used to validate the generated surface
against a real running worker ahead of the production transport landing.

## Development

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[gen,dev]"
.venv/bin/python3 scripts/generate.py
.venv/bin/python3 -m pytest
```

Format, lint, and typecheck (all run in CI, on every file — generated code
included):

```bash
.venv/bin/python3 -m black --check src/qvac scripts/ tests/
.venv/bin/python3 -m ruff check src/qvac scripts/ tests/
.venv/bin/python3 -m mypy -p qvac
.venv/bin/python3 -m mypy scripts
.venv/bin/python3 -m mypy tests
```

`scripts/generate.py` runs `black` and `ruff --fix --select I` on its own
output as part of the build, so a fresh regeneration should already pass all
three checks above.
