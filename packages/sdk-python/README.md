# tetherto-qvac-sdk — Python SDK

The Python client for QVAC: local-first, P2P AI inference (LLM completion,
embeddings, transcription, TTS, OCR, translation, diffusion, VLA, …) through the
same worker and the same contract as the TypeScript `@qvac/sdk`. Asyncio-native.

The package version tracks the `@qvac/sdk` version it speaks (e.g. `0.15.0`), so
a given python-sdk release makes clear exactly which SDK it targets.

## Install

Getting started is two steps: install the Python package, then make the QVAC
**worker** available. The package is a thin client — all inference runs in the
worker (the QVAC runtime, `@qvac/sdk`), so **the worker must be installed for
anything to run**.

**1. Install the package**

```bash
pip install "tetherto-qvac-sdk[bare-rpc]"
```

The `bare-rpc` extra is **required** — it's the wire transport (`bare-rpc-python`)
the client speaks to the worker. It's an extra only because its dependencies are
git-only for now; it folds into the base install once they're on PyPI. Genuinely
optional extras: `vla` (numpy), `notebook` (numpy + pandas). (`langdetect` is no
longer needed — source-language detection moved into the worker.)

**2. Install the worker** (one time) — either route works; both need Node.js:

```bash
# via Python — fetches the exact worker version this package speaks and caches
# it under ~/.cache/qvac/worker/<version>:
python -m tetherto.qvac_sdk install-worker

# or via npm — install the @qvac/sdk version that MATCHES this package (they
# share a version, so use your installed tetherto-qvac-sdk version here;
# Client() warns on a mismatch):
npm install -g @qvac/sdk@0.15.0
```

That's it — `Client()` finds the worker automatically (see "Worker resolution"
below for the full lookup order, including pointing `QVAC_SDK_DIR` at a
locally-built `@qvac/sdk` for development). The Python route is the recommended
first run: it pins the worker to the exact version this package was generated
against, so you never have to track the version yourself.

## Quickstart

```python
import asyncio
from tetherto.qvac_sdk import Client, load_model, completion, unload_model
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0


async def main():
    async with Client() as client:
        t = client.transport
        model_id = await load_model(t, model_src=LLAMA_3_2_1B_INST_Q4_0)
        run = completion(
            t,
            model_id=model_id,
            history=[{"role": "user", "content": "Explain quantum computing in one sentence"}],
        )
        async for event in run.events:
            if event.type == "contentDelta":
                print(event.text, end="", flush=True)
        print()
        await unload_model(t, model_id)


asyncio.run(main())
```

More in [`examples/`](./examples) — one runnable example per major capability
(completion events / tools / worker-orchestrated tools, cancel, embeddings,
translation, transcription, TTS, OCR, registry queries, model info, logging,
VLA, plugins), mirroring `packages/sdk/examples`.

## The public API (`tetherto.qvac_sdk`)

Everything you normally need is re-exported flat from `tetherto.qvac_sdk`; model constants
live in `tetherto.qvac_sdk.models`.

- **`Client`** — starts/owns a worker connection; `client.transport` is passed
  to every call.
- **Ergonomic wrappers** (kwargs + typed results): `load_model`, `unload_model`,
  `completion`, `translate`, `cancel`, `delete_cache`, `invoke_plugin` /
  `invoke_plugin_stream`, `model_registry_list` / `_search` / `_get_model`.
  (Tool calling is `completion(tools=...)`; the worker-orchestrated loop is an
  advanced path at `tetherto.qvac_sdk._completion.completion_orchestrate`, not flat-public.)
- **Result types**: `CompletionRun` (`.events`, `.final`), `CompletionFinal`,
  `ToolCall`, `TranslateRun`.
- **Generated method stubs** for every other contract method (`embed`,
  `transcribe`, `text_to_speech`, `ocr_stream`, `diffusion_stream`, `classify`,
  `get_model_info`, `download_asset`, …), each taking a typed request model.
- **Request/response models + enums** (`LoadModelRequest`, `ModelType`, …),
  also available in full from `tetherto.qvac_sdk.schemas`.
- **Errors** (`QvacError`, `RPCError`, `InferenceCancelledError`,
  `ContextOverflowError`, …) for `except`/`isinstance`.
- **Logging**: `logging_stream`, `subscribe_server_logs`, `SDK_LOG_ID`,
  `SDK_ALL_LOG_ID`. **VLA**: `vla`, `vla_hparams`, `vla_preprocess_image`,
  `vla_pad_state`.
- **Notebook facade**: `tetherto.qvac_sdk.notebook.SyncClient` — synchronous, numpy/pandas
  returns, live in-cell streaming.

The raw generated method stubs are also in `tetherto.qvac_sdk.methods`, and the pydantic
models in `tetherto.qvac_sdk.schemas`, if you prefer the explicit modules.

## Notebook / data science

For notebooks and REPLs, `tetherto.qvac_sdk.notebook.SyncClient` runs the async
client on a background thread so every call is plain and blocking (no `await`),
with numpy/pandas returns and live in-cell streaming. Needs the `notebook`
extra (`pip install "tetherto-qvac-sdk[notebook,bare-rpc]"`):

```python
from tetherto.qvac_sdk.notebook import SyncClient
from tetherto.qvac_sdk.models import EMBEDDINGGEMMA_300M_Q4_0

with SyncClient() as client:
    m = client.load_model(model_src=EMBEDDINGGEMMA_300M_Q4_0)
    vec = client.embed(m, "hello")                 # 1-D numpy array
    df = client.embed_frame(m, ["a", "b", "c"])    # pandas DataFrame, indexed by text
```

`embed` returns numpy arrays, `embed_frame` a DataFrame, `completion` streams
live and returns the text, and `transcribe`/`text_to_speech` round-trip audio
as numpy. Full examples: [`examples/notebook.ipynb`](./examples/notebook.ipynb)
(Jupyter) and [`examples/notebook.py`](./examples/notebook.py) (script).

## Configuring the SDK

`Client(config=...)` (and `BareRpcTransport(config=...)`) sends an SDK
config to the worker on connect — the same `QvacConfig` the TypeScript client
applies (`cacheDirectory`, `loggerLevel`, `swarmRelays`, per-device plugin
defaults, …):

```python
async with Client(config={"cacheDirectory": "/data/qvac-models", "loggerLevel": "warn"}) as client:
    ...
```

`cacheDirectory` (must be absolute) relocates where models are stored — handy
for a shared/mounted cache. As a shortcut, the `QVAC_CACHE_DIR` env var sets
`cacheDirectory` without code (used by CI to point at a warm model cache).

## Worker resolution

`Client()` locates a worker by trying, in order: explicit `worker_path` /
`bare_path` (or `QVAC_WORKER_PATH` / `QVAC_BARE_PATH`); a self-contained
**bundled wheel** (`tetherto/qvac_sdk/_bundle/`, zero config); `sdk_dir` / `QVAC_SDK_DIR`
pointing at an installed `@qvac/sdk`; a worker fetched by **`python -m tetherto.qvac_sdk
install-worker`** (into `~/.cache/qvac/worker/<version>`, overridable with
`QVAC_WORKER_HOME`); then a global `npm install -g @qvac/sdk`. The fetched
worker is version-locked to this package.

## Staying in sync with `@qvac/sdk` (drift avoidance)

The rule: **generate what can be generated; put un-generatable behaviour in the
worker; hand-write per language only what is irreducibly client-side, and never
*trust* it to match — guard it.**

- **Generated from the one contract.** The pydantic models + typed method stubs,
  the model-type resolution maps (`_generated/model_type_maps.py`), the
  error-code registries (`_generated/error_codes.py`), and the pinned SDK
  version (`_generated/sdk_version.py`) are all generated from
  `../sdk/contract/**`. `generate.py --check` (and the SDK's `contract:check`)
  fail CI if either side drifts.
- **Behaviour lives in the worker.** `translate` source-language detection and
  the completion tool-loop (`completionOrchestrate`) run in the worker, so
  Python and JS share one implementation instead of two that diverge (they did:
  Python once used `lingua`, JS `@qvac/langdetect-text`).
- **Version lock-step.** This package's version *is* the `@qvac/sdk` version it
  was generated against.
- **Conformance corpus.** `../sdk/e2e/conformance/cases.json` is run by both a
  JS runner and `tests/test_conformance.py`, so the two clients are diffed
  against the same cases.

The irreducibly-client-side code (typed error classes, numpy marshaling, stream
assembly, the notebook facade) is the only hand-written surface mirroring the JS
client, and it's covered by the conformance corpus + real-worker tests rather
than trusted to match.

## Development

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[gen,dev,bare-rpc]"
.venv/bin/python3 scripts/generate.py          # regenerate from ../sdk/contract
.venv/bin/python3 -m pytest                     # unit + (with a built worker) real-model e2e
```

Format, lint, typecheck, and the generation check (all run in CI):

```bash
.venv/bin/python3 scripts/generate.py --check
.venv/bin/python3 -m black --check src/tetherto/qvac_sdk scripts/ tests/
.venv/bin/python3 -m ruff check src/tetherto/qvac_sdk scripts/ tests/
.venv/bin/python3 -m mypy -p tetherto.qvac_sdk && .venv/bin/python3 -m mypy scripts tests
```

Real-model tests spawn a worker (`packages/sdk` built via `bun run build`, or
`QVAC_POC_SDK_DIR`) and otherwise skip. `generate.py` runs `black` + `ruff --fix
--select I` (with the package config) on its own output, so a fresh
regeneration already passes the checks above.
