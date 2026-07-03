# VLM Benchmark — Checkpoints

A **checkpoint** is a periodic, reproducible snapshot of the VLM baseline — the two
reference models (**Qwen3.5-0.8B** and **Gemma-4-E2B**) measured across every platform and
accelerator with the frozen `full` preset. We collect checkpoints over time in
[`checkpoints/`](./checkpoints/) to **track improvements and regressions in the QVAC VLM
ecosystem** (addon, llama.cpp/fabric, model quants, per-platform backends).

Each checkpoint is **3 identical CI runs** aggregated into **two per-model tables** of
`avg ± deviation%` per `Platform · Accelerator`, with an env header recording the exact
quants, addon version, preset, and date.

---

## What a checkpoint fixes (the definition)

Keep these **constant** across checkpoints so they stay comparable — only the *addon /
ecosystem under test* changes over time:

| Axis | Value |
|---|---|
| Mode | `two-models` |
| Models | `qwen3.5-q8` (LLM Q8_0 + mmproj Q8_0) · `gemma4-q4` (LLM Q4_K_M + mmproj Q8_0) |
| Preset | `full` (cognitive VQA×5 + ocr-small ×5 + 1 ocr-page) |
| Desktop | `linux-cpu,linux-gpu,macos-cpu,macos-gpu,windows-cpu,windows-gpu` |
| Mobile | `s26,iphone17pro,pixel9` (each = CPU+GPU in one Device-Farm session) |
| Addon | **latest published** `@qvac/llm-llamacpp` (the `addon` source packs `@latest`) |
| Dispatch ref | `main` (uses the current benchmark tooling + published addon) |
| Runs | **3**, run **sequentially** (see gotchas) |

Metrics captured per `Platform · Accel`: **mmproj-enc** (desktop) / **TTFT** (mobile),
**full inference** (wall), **cognitive %** (VQA Overall), **OCR %** (avg BLEU×100).

---

## Procedure

### 1. Trigger 3 runs from `main` (sequentially)

```bash
gh workflow run benchmark-vlm-model-comparison.yml --repo tetherto/qvac --ref main \
  -f matrix_mode=two-models \
  -f matrix_models=qwen3.5-q8,gemma4-q4 \
  -f matrix_preset=full \
  -f matrix_desktop=linux-cpu,linux-gpu,macos-cpu,macos-gpu,windows-cpu,windows-gpu \
  -f matrix_mobile=s26,iphone17pro,pixel9 \
  -f mobile_timeout_min=60
```

Run this **three times, waiting for each to finish before starting the next**. Note the
three run IDs (from the dispatch URL or `gh run list`).

### 2. Collect the combine reports

```bash
cd packages/llm-llamacpp/benchmarks/vlm-benchmark/checkpoint
./collect-reports.sh <run-id-1> <run-id-2> <run-id-3>
```

Produces `report-1.md`, `report-2.md`, `report-3.md`.

### 3. Aggregate into the two tables

```bash
node aggregate-checkpoint.cjs --date "$(date +%F)" report-1.md report-2.md report-3.md
```

Prints the two per-model markdown tables with env headers (addon version auto-detected
from the reports).

### 4. Save the checkpoint

Write the output to `checkpoints/<YYYY-MM-DD>_addon-<version>.md` (e.g.
`checkpoints/2026-07-01_addon-0.31.0.md`), add the three run URLs at the bottom, and commit
it. Then clean up the scratch `report-*.md`.

---

## For an AI assistant

When the user says **"make a checkpoint"**:

1. Dispatch the run in step 1 **three times, sequentially** (wait for each run to complete
   — poll the run status — before dispatching the next; do **not** run them concurrently).
2. Run `collect-reports.sh` with the three run IDs, then `aggregate-checkpoint.cjs`.
3. **Output the two per-model tables to the user** exactly as produced (env header + table
   per model), and save them to `checkpoints/<date>_addon-<version>.md`.
4. Report any cell with `failed > 0`, and call out large deviations / `†` / `(nX)` cells
   (see gotchas). Do **not** modify any benchmark files to force a result.

---

## Reading a checkpoint

- **Value = `avg ± deviation%`** (deviation = sample stdev / mean across the 3 runs).
- **`mmproj-enc`** is filled for desktop only; **`TTFT`** for mobile only (`—` in the other).
- **`†`** = the *median* is shown instead of the mean, because a one-run outlier skewed the
  average (almost always self-hosted **desktop-CPU** runner contention). Treat desktop-CPU
  *speed* with a wide tolerance (~±20%).
- **`(nX)`** = fewer than 3 samples contributed to that cell (a dropped mobile marker row).
- **Quality (cognitive %, OCR %) is deterministic (`±0%`)** → the strongest regression
  signal: any drop there is real, not noise. Speed is the noisier axis.

## Gotchas

- **Run sequentially.** Concurrent runs put 6+ sessions on AWS Device Farm at once, which
  makes the monitor step time out (the mobile legs fail even though the app builds). One run
  at a time keeps it to ≤3 mobile sessions and stays clean.
- **pixel9 queues.** The pixel9 Device-Farm pool is small; a pixel9 leg can take ~1 h
  (mostly queue). `mobile_timeout_min=60` gives the per-test/Mocha ceilings enough headroom.
- **Desktop-CPU speed is noisy** (self-hosted runners are shared) — expect high deviation
  there; the `†` median is the representative value. Everything else is stable (±1–8%).
- **Addon version:** two-models runs pack `@qvac/llm-llamacpp@latest`, so the checkpoint
  captures whatever is published on npm at run time — recorded in each table's header.
