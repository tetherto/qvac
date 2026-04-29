# SDK 0.10.0 — documentation gaps review

## Gaps that already have an Asana task

| # | Gap | Source PR | Asana task | Section |
|---|---|---|---|---|
| 6 | `cli.mdx` has no `qvac doctor` section; `system-requirements.md` not surfaced on website. | [#1681](https://github.com/tetherto/qvac/pull/1681) (QVAC-12239, `feat[api]` — open) | [Missing dependency manifest or system requirements checker](https://app.asana.com/1/45238840754660/project/1212638335655966/task/1213135939015661) (QVAC-12239) — docs are part of implementation scope | TO DO |
| 7 | Capability system `[bc]` will need sweeps in `loadModel.mdx`, `getModelByName.mdx`, `getModelInfo.mdx`, `modelRegistry*.mdx`, and the model-types list under `DeviceConfigDefaults` in `configuration.mdx`. | [#1748](https://github.com/tetherto/qvac/pull/1748) (QVAC-11476, `feat[bc|api]` — open) | [Improve SDK Model Type And Capability Handling](https://app.asana.com/1/45238840754660/project/1212638335655966/task/1212948486598506) (QVAC-11476) | IN REVIEW |
| 8 | Whisper per-segment metadata (timestamps / scores) needs return-shape updates in `transcribe.mdx` / `transcribeStream.mdx`. | [#1701](https://github.com/tetherto/qvac/pull/1701) (QVAC-17184, `feat[api]` — open) | [\[SDK\] Propagate Whisper output fields besides \[text\] from addon to user in SDK](https://app.asana.com/1/45238840754660/project/1212638335655966/task/1214057854181170) (QVAC-17184) | IN PROGRESS |