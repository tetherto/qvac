# Diffusion performance evaluation, 29 October 2026

This directory preserves the measured research record on RTX 5090 and DGX
Spark. It is evidence for selecting the next implementation, not a production
engine upgrade. No model weights, generated media, binaries, credentials,
private raw logs or host connection details are included.

- `report-content.json` contains the model descriptions, eight-column decision
  tables, measured cumulative profiles, limitations and validation status.
- `reproduction-records.json` contains individually hashed UTF-8 records with
  virtual filenames: benchmark inputs, measurements, checkpoint identities,
  source revisions, quality comparisons and build/CI evidence. Decode each
  `content` value to the named file and verify its recorded SHA256.
- `catalog.json` within the records distinguishes native addon measurements,
  fresh-process engine experiments, alternate runtimes and failed probes.
- `../h3-isolated-fusions.json` and its patch describe the unapplied H3
  experiment. They do not modify the engine used by this addon.

For native runs, use the repository's `scripts/inference-benchmark.js` and
the exported `readme.txt`. Set model/backend paths for the chosen device;
mask the authorized GPU externally. Do not change host configuration.
Keep the recorded source and checkpoint identities when reproducing results.
Native timings use the recorded 0.31.0 build; the refreshed feature branch
contains 0.32.1 and must not inherit those performance claims without reruns.

Raw output media and task logs are preserved separately in verified local
archives or a manifest-indexed content store. The JSON records retain numerical quality results and content
identities. Do not commit those private archives or deployment helpers.

Next acceptance gate: same-checkpoint Metal measurements on Mac Studio,
then a focused engine backport where needed, addon overlay validation and
repeated CUDA regression checks on that exact implementation. Preserve the
existing full desktop CI matrix. Keep CUDA-only profiles scoped to CUDA;
Strix/Vulkan/ROCm performance remains unmeasured. No PR is opened here.
