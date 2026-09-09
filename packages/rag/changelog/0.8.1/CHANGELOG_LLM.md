# QVAC RAG v0.8.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.8.1

This patch makes TurboVec-backed RAG usable on Windows. In 0.8.0 every attempt to open a TurboVec workspace failed there, and the package could not be built on Windows at all.

## Fixed

### TurboVec workspaces open and checkpoint on Windows

`TurboVecAdapter` forces its writer lock and its checkpoint files to disk before installing them, and Windows refuses that unless the file was opened for writing. Opening a workspace therefore always ended in `Failed to acquire the TurboVec writer lock`. Workspaces now open, checkpoints complete, and the journal records a checkpoint covers are pruned, so a Windows workspace no longer retains every mutation record. When the lock genuinely cannot be taken, the error names the underlying reason rather than only a generic code.

### `@qvac/rag` builds on Windows

Installing the package on Windows failed while running its build, because the build scripts derived their own directory from a file URL and produced a doubled drive letter (`C:\C:\...`). The integration test and the quickstart example resolved their fixture paths the same way.
