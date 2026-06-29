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
| `rss_mb` | peak process memory so far (MB); populated on desktop and mobile (Android + iOS), `null` only where the platform doesn't expose it |

`[VLMSEG]`/`[VLMMETA]` gain `v`, `scenario`, `source_id`, `source_ref` (SEG also `block`).
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
[label=]<llm-url>|<mmproj-url>[@ctx=N]            # ANY new model: two https URLs, zero code changes
json:[{label, ctx_size, llm:{source}, mmproj:{source}}, …]   # escape hatch (registry sources etc.)
```

`|` separates the blobs (never appears unencoded in URLs). `huggingface.co/...resolve/<ref>/...`
URLs are reported as Source=HF with repo+ref (unpinned refs flagged); other URLs as URL/S3.
Registry-type sources: `json:` form only, desktop-only (no registry client in the mobile app).
Presigned S3 URLs work for a one-off dispatch but expire — don't commit them to the catalog.

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
