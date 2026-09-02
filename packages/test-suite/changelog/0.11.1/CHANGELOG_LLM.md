# QVAC Test Suite v0.11.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.11.1

A single fix: memory samples now appear in e2e reports on Windows. Desktop and Electron runs on Windows previously produced reports with no memory data at all, and did so silently.

---

## Bug Fixes

### Memory sampling works on Windows

The memory poller collected resident set size by shelling out to `ps`, which does not exist on Windows. Desktop and Electron consumers on Windows therefore reported no memory at all — and because the collector failed quietly rather than erroring, the gap looked like a suite that simply had nothing to report.

Windows now has its own collector. It keeps a single PowerShell process alive and queries `Win32_Process` through CIM for process ids, parent ids and working-set bytes, so a whole test run costs one process start rather than one per sample. That matters at the polling rate involved: starting PowerShell per sample would have added enough overhead to distort the very numbers being measured.

The collector reuses the existing process-tree aggregation, so a sample covers the consumer together with its Bare workers, and excludes the PowerShell collector itself from the total. Windows polls every 500 ms.

Nothing changes for existing consumers. The POSIX path is untouched, the emitted `qvac/app-memory` payload keeps the same shape, and reports produced on macOS and Linux are byte-for-byte what they were before. Collector startup and any failure are now logged, so a future gap surfaces as a log line instead of an empty section.

Process exits, stream failures, collector restarts and shutdown are all handled without leaking a PowerShell process or stalling the consumer, and outstanding snapshot requests are bounded.
