# Changelog v0.8.0

Release Date: 2026-11-05

## ✨ Features

- `downloadModel` and `downloadBlob` take `clearBlocksOnCancel`, a boolean or a callback read when the signal aborts. Pass `false` to keep a cancelled download's blocks so the next download resumes from them; the default still clears them (#5534).
- `clearBlob(binding)` deletes a blob's cached blocks, such as those a kept cancel or a failed download left behind (#5534).

## 🔧 Changed

- A download that fails without being cancelled keeps its blocks, so a retry resumes instead of starting from zero. Reclaim them with `clearBlob` (#5534).

## 🐛 Fixed

- A download of a blob waits for an earlier cancel or `clearBlob` of the same blob to finish, so it no longer counts blocks that are about to be deleted and stalls at 100% (#5534).
- A `clearBlocksOnCancel` callback that throws falls back to clearing, still releases the core, and the cancel error is the one that propagates (#5534).
