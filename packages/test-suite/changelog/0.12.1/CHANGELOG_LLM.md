# QVAC Test Suite v0.12.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.12.1

Two fixes that close blind spots in what a run reports. Per-OS skip rules now reach the desktop and Electron legs they were written for, and a test that stops running is no longer allowed to vanish from a report comparison.

Both make a run stricter rather than quieter, so expect visible changes after upgrading: some tests that ran on Linux and Windows legs will now report as skipped, and a comparison that previously passed can now fail.

---

## Bug Fixes

### Per-OS skip rules apply to desktop and Electron legs

`skip.platforms` matches by segment and widens over the OS only, so a leg that registers the bare family name — `desktop` or `electron` — never reached a per-OS rule. Every JavaScript consumer did exactly that: `--platform` defaulted to `desktop`, and the Electron command passed `electron`. Mobile, Snap and Python legs already named their OS.

The per-OS rules were therefore inert on five legs. A test recorded as skipped for `desktop-linux`, `desktop-windows`, `electron-linux` and `electron-windows` ran on all four anyway.

Each JavaScript consumer now registers as `<family>-<os>` — for example `desktop-linux` or `electron-windows` — through one shared helper. The `--platform` CLI default is gone, so the runner's own fallback decides. The desktop runner also publishes the label it registered with in `QVAC_TEST_PLATFORM`, as the Electron path already did, so a consumer entry can apply its resource table against the same string the leg registered with instead of deriving a second one that may disagree.

macOS legs behave the same either way. The change lands on Linux and Windows, where tests covered by a per-OS skip rule now report as skipped instead of running.

### A test that stops running fails the comparison

`report:compare` classified every test as passed or failed, but a run records four outcomes. A test that passed in the baseline and now reported `incomplete` or `skipped` fell into neither list — it disappeared from the comparison and the check stayed green. Removing a step binding, or no longer wiring an SDK method into a client, silently shrank coverage on every affected test with nothing reacting to it.

The two ways a test stops running are now kept apart, because only one of them is the client's doing:

- **Passed, now `incomplete`** is a coverage regression and **fails** the comparison. Incomplete means the client has no body or binding for the test, which no property of the machine can cause.
- **Passed, now `skipped`** is reported on its own line and stays non-fatal. Skips also come from the runner's own limits — the number of eligible GPUs, a reachable LAN server, an opt-in environment flag — which legitimately differ between the baseline machine and the one running the change.

A test that was already incomplete or skipped in the baseline is the status quo and stays quiet, so adopting this release does not fail a comparison on its own. Both lists reach the PR comment through `report:format`, and the summary now states how many tests the success rate left out.

The HTML report had the same gap: its summary listed passed, failed and skipped, so a run with incomplete tests did not add up. It now has an Incomplete card, and the per-consumer strip reports all four states and computes its rate over the tests that ran.
