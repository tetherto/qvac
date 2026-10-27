# Chat first, branded everywhere, and its own app

Status: accepted, from the owner's direction on 2026-10-21 and 2026-10-22. Supersedes the parts of
[0001](0001-workbench-boundaries.md) named below.

- **Chat is in V1 and is where `qvac` opens.** The walkthrough's V1 was a headless server with no
  chat; the owner moved chat in. The dashboard (Overview, Device, Models) is one key away (`Enter`
  from chat's tab row back, `Ctrl+G` either way), and every dashboard page keeps a composer so chat
  is never hidden.
- **The branded header stays in chat.** 0001 said the serving header, logo and navigation do not
  persist into chat. They do now: the same header, rules and tab row on every page, because chat
  without them lost what makes the product recognisable.
- **A rework, not a migration.** The duck `ChatApp` is not wrapped or extended; the TUI is a
  standalone model on bare-tui, and Core is booted by the CLI's own host (`src/lib/runtime/core-host.ts`),
  not through Core's `tui/`.
- **`qvac serve` is the headless host.** It replaces `--headless` and `qvac host serve` (kept as an
  alias). The SDK CLI's API server, which 0.16 called `qvac serve`, is `qvac sdk serve`.
- **Features are chosen for QV.AC.** They build on what is ours (P2P workspaces, borrowed compute,
  harness plugins, Hypercore-shared runs), not on another tool's command list.

Unchanged from 0001: Core, Client and the harness keep their boundaries; the TUI never instantiates
its own harness; one `qvac.config.*` with `core`, `harness` and `tui` namespaces.
