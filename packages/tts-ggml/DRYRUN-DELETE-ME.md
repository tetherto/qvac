# Dry-run scaffold (delete me)

Temporary file to make a dry-run PR flag `tts-ggml` as a changed package so the
merge-guard `verify-prebuilds` job exercises the new prebuild-status protocol
(publish -> verify) before merge.

This file, and the `DRYRUN-ONLY` trigger/checkout edits in
`.github/workflows/pr-gate-merge.yml` and `.github/workflows/on-pr-tts-ggml.yml`,
must be reverted/removed before merging the real PR.
