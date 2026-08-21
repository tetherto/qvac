# VLM Benchmark — Contract v2

The frozen interface between the two halves of the benchmark:

- **Runner side** — *produces* markers: `harness.cjs`, `models.cjs`, `sources.cjs`,
  `methodology.cjs`, `run-desktop.cjs`, `build-cli-sources.js`/`cli-*`, `config.cjs`,
  the workflow's `context`/`matrix-desktop`/`matrix-mobile`/`prebuild` jobs.
- **Report side** — *consumes* markers: `aggregate.js`, the scorers, `combine.cjs`,
  `scenarios.cjs`, `fixture*`/`build-fixture.cjs`, `score-check.cjs`, the workflow's
  `inputs:` block and `matrix-combine` job.

**Change rule:** the runner may *add* marker fields, never rename/remove; the report must
*ignore* unknown fields and unknown `[VLM*]` marker kinds. Any change to THIS file after the
freeze requires keeping both sides in sync. `markers-v2.sample.txt` is the executable half
of this contract — report views build against it; `node run-desktop.cjs --selfcheck`
validates it (and the config wiring) without running any model.

## 1 · Marker schema v2 (additive over v1)

`[VLMROW]{json}[/VLMROW]` — one inference. v1 fields unchanged (`cell`, `source`, `model`,
`device`, `rep`, `task`, `id`, `metric`, `gold`, `pred`, `img`, `img_w/h`, `ms`,
`decode_tps`, `ttft_ms`, `gen_tokens`, `prompt_tokens`, `error`). New:

| field | meaning |
|---|---|
| `v` | schema version (`2`); absent = legacy v1 row (still parsed) |
| `scenario` | active task set, key into `scenarios.cjs` (currently just `default`) |
| `source_id` | which build produced the row: `addon`, `addon@candidate`, `addon@baseline`, `fabric@<ref>`, `upstream@<ref>` |
| `source_ref` | resolved version: `npm:<ver>` \| `git:<sha>` \| tag |
| `block` | measurement round: `0` = warmup (excluded from stats), `1..N` = measured; report takes the **median** across blocks |
| `rss_mb` | peak process memory so far (MB); populated on desktop and mobile (Android + iOS), `null` only where the platform doesn't expose it. CLI legs read it from the `/usr/bin/time -v` wrapper, which is Linux-only, so they report `null` on macOS and Windows |

`[VLMSEG]`/`[VLMMETA]` gain `v`, `scenario`, `source_id`, `source_ref` (SEG also `block`).
`[VLMMETA]` also carries `preproc`: the per-model preprocessing that leg actually applied, as
a sorted `key=value` string on the addon spelling, so an addon leg configured through
`addonConfig` and a CLI leg configured through `cliArgs` are directly comparable. An empty
string means base preprocessing; absent means the log predates the field. Where the legs of one
model disagree, the report says so under the origins table rather than letting the rows read as
like for like.
New optional `[VLMBLOCK]{json}` — one per measurement round: `{scenario, source_id,
source_ref, model, device, block, stability:{kind:'temp'|'probe', value_ms?, waited_ms}}`.

## 2 · Env contract (desktop: workflow env · phones: the pushed device-config file)

| var | value |
|---|---|
| `QVAC_VLM_MODELS` | models grammar (§3); may be wrapped `b64:<base64(utf8)>` (used for the on-device transport). Empty = config defaults |
| `QVAC_VLM_SCENARIOS` | CSV of scenario names; **the runner currently executes the first token** (multi-scenario reserved). Empty = `config.defaultScenario` |
| `QVAC_VLM_SOURCE_ID` / `QVAC_VLM_SOURCE_REF` | stamped into markers by the leg that knows what build it runs |
| existing | `QVAC_VLM_MODE/PRESET/DEVICES/SAMPLES/REPEATS/TASKS`, `NO_GPU`, `QVAC_VLM_MATRIX` — unchanged |

## 3 · Launch grammar (`gh workflow run` inputs)

**`matrix_models`** — comma-separated, three forms, freely mixed; empty = config `defaultModels`:

```
qwen3.5-q8                                        # catalog name (config.cjs catalog)
[label=]<llm-url>|<mmproj-url>[@ctx=N]            # CLI legs only: two https URLs, zero code changes
json:[{label, ctx_size, llm:{source}, mmproj:{source}}, …]   # escape hatch (registry sources etc.)
```

`|` separates the blobs (never appears unencoded in URLs). `huggingface.co/...resolve/<ref>/...`
URLs are reported as Source=HF with repo+ref (unpinned refs flagged); other URLs as URL/S3.
The pair form reaches the **CLI legs only**. The addon leg downloads through `ensureModel()`,
which resolves the blob by `modelName` against `models.manifest.json` and verifies the sha256
pinned there, so a URL it has never seen has no integrity pin and is refused. Use the pair form
for a CLI-only dispatch (`matrix_sources=fabric@<ref>`); anything with an addon leg needs a
catalog name, or a `json:` spec whose `modelName` matches a manifest key.
Registry-type sources: `json:` form only, desktop-only (no registry client in the mobile app),
and addon-only. Only the addon leg has a registry client, so a registry blob reaches a CLI leg
only when an addon leg in the same job already fetched it; a CLI-only dispatch cannot compare
one. Presigned S3 URLs work for a one-off dispatch but expire, so don't commit them to the
catalog.

In **several-sources** mode the model axis is fixed, so only the FIRST token is used; empty
falls back to `config.sourcesModel`. Both legs resolve it identically (`harness.cjs runAll()`
for the addon, `resolve-cli-model.cjs` for the native CLIs), so a model with no catalog entry
can be compared across engines with no config commit. A dispatch with CLI sources only
(`matrix_sources=fabric@<ref>`) runs no addon leg at all, and the CLI step downloads the two
blobs itself, which is what a model the published addon cannot load yet needs. Those downloads
are checked against a sha256 pin, taken from `models.manifest.json` when the `modelName` is a
manifest key and otherwise from a `sha256` field on the blob. A blob with neither fails the
leg, because an unverified GGUF's own chat template goes on to reach `--chat-template`; set the
`allow_unverified_models` dispatch input to run one anyway. A blob that fails the check is
deleted and fetched once more before the leg gives up, so a truncated file left behind by a
cancelled run recovers by itself instead of failing every rerun.

A model needing a per-model flag (VisionPsy Flash needs `--image-no-upscale on`, else it runs
base preprocessing and the run measures the wrong thing) carries it as `cliArgs` for the native
CLIs and `addonConfig` for the addon. Both live on the spec, so a catalog entry or a `json:`
spec can set them; a bare `<llm-url>|<mmproj-url>` pair cannot. Use `json:` for a one-off run of
such a model, not the pair form.

Both are restricted to per-model **multimodal** settings and nothing else, checked at parse
time on both sides. `cliArgs` accepts only `--image-no-upscale`, `--image-tile-mode`,
`--image-max-tokens`, `--image-min-tokens`; `addonConfig` the same `image-*` keys plus
`mmproj-use-gpu`, in either spelling. Everything else is rejected, including the model files,
device, sampling params, context size and `reasoning-budget`, all of which the harness fixes
so that the legs stay comparable.

This is an allowlist on purpose: llama.cpp gives most options several spellings (`-n` /
`--predict` / `--n-predict`, `-ngl` / `--gpu-layers` / `--n-gpu-layers`, `--temp` /
`--temperature`), extra args are appended after the harness's own, so a late alias would win,
and a fabric bump can add a spelling at any time. Widening it is a deliberate code change to
the single `MODEL_OPTIONS` descriptor in `models.cjs`, which both allowlists are derived from,
so the CLI and addon sides cannot drift apart. `--image-max-tiles` is absent from it because
arg.cpp takes it and the addon has no handler, so it could only ever be set on one leg.

**An option with a twin must be set on both legs, with the same value.** This is enforced per
spec, not merely documented: a `json:` spec with `cliArgs: ['--image-no-upscale', 'on']` and no
matching `addonConfig` is rejected at parse time, as is one where the two values disagree. A
one-sided flag would otherwise have the CLI leg and the addon leg run different preprocessing
under a single model label, which is the exact failure the pairing exists to prevent.
`mmproj-use-gpu` is exempt because it has no CLI equivalent to match.

Note that `fabric` and `upstream` remain deliberately asymmetric: `cliArgs` reach the fabric
CLI only, since these flags are fork additions and `upstream-cli` aborts on an unknown
argument. So an `upstream-cli` leg of a model needing a flag runs base preprocessing by
design. Read that leg as a baseline, not as the same configuration.

Write `cliArgs` in the split form, `['--image-no-upscale', 'on']`. arg.cpp looks the whole
argv token up and never splits on `=`, so `--image-no-upscale=on` is an unknown argument to
it; models.cjs rejects that form rather than letting the CLI abort mid-run. Values must also
match on both sides: `--image-tile-mode` takes only `batched` / `sequential` / `disabled` on
the CLI, while the addon additionally accepts `0` / `1` / `2`, so use the words.

`mmproj-use-gpu` is allowed because it selects the backend for the **projector only**, which
`device` does not control. On Android the addon auto-defaults it by GPU class: GPU on Adreno
800+, CPU on Mali and on any tier it cannot identify. A plain `device: gpu` leg on a Mali
phone therefore runs the language model on Vulkan and the vision encoder on CPU, so exercising
the Mali Vulkan encoder requires setting this explicitly. The addon logs which it picked,
`[LlamaModel] multimodal projector backend: GPU|CPU (<reason>)`, and that line is the only
reliable way to tell from a run which path was measured.

**`matrix_sources`** — comma-separated builds-under-comparison: `addon` (published, default) ·
`addon@candidate` / `addon@baseline` *(build comparison)* · `fabric@<ref>` ·
`upstream@<ref>` (CLI sources are desktop-only — Linux/macOS/Windows — several-sources mode).

**Scenario** — task-set name from `scenarios.cjs` (`config.defaultScenario`, single `default`
set today). Config-only: there is no `matrix_scenarios` dispatch input (local override via
the `QVAC_VLM_SCENARIOS` env still works).

**`matrix_desktop` / `matrix_mobile` / `matrix_preset` / …** — unchanged (see README).
GitHub caps `workflow_dispatch` at **10 inputs**, and the benchmark now uses all **10**
(the vestigial `run_matrix` switch was removed — the matrix always runs — and that slot
was reclaimed by `baseline_npm`, which pins `addon@baseline`; empty = auto-detect latest).

## 4 · Quality reporting (no gate)

This benchmark is **descriptive**: it reports how good each model is per task (and one
model across sources). It does **not** gate on accuracy — it compares *different* models,
not a candidate vs a baseline of the same model, so there's nothing to regress against.
`combine.cjs` is green whenever it produced a report.

Scoring families (each fixture item carries its own `metric`):
- `vqa` / `anls` / `relaxed` / `mc` → higher-better, shown as `%` (Overall % = equal-weight mean).
- `ocr` → **CER ↓ / WER ↓ / BLEU ↑**, shown in a **separate OCR table** (never blended into `%`).

OCR fixture items (`ocr-small`, `ocr-page`) are hand-curated from S3 images — see
`fixture/README.md`.
