# Configuration

`qvac` builds one configuration from three layers, each on top of the one before:

1. **Built-in defaults**, chosen for the folder you start in and the machine you are on.
2. **Your `qvac.config.*`**, merged over the defaults.
3. **`/plugins` toggles**, from `<storage>/plugins.json`, applied when Core starts.

`qvac config` prints the result, one `key = value · source` line per setting, where the source is
`default`, `config` or `plugins.json`. `qvac config --json` prints the same as one JSON value.

- [Where the file lives](#where-the-file-lives)
- [The defaults, and why](#the-defaults-and-why)
- [Merge rules](#merge-rules)
- [Every key](#every-key)
- [Examples](#examples)

## Where the file lives

`qvac` looks in the current folder for `qvac.config.json`, `.js`, `.mjs` or `.ts`, in that order.
`--config <path>` picks one explicitly. A `.js`, `.mjs` or `.ts` file default-exports an object. The
file has no functions in it: plugin code goes in a module that `harness.plugins[].use` names.

Relative paths (`core.dataDir`, `core.modelsDir`, `core.folders`, a plugin `use` path) resolve
against the config file's folder, and `~` is your home folder.

A full example is [`docs/examples/qvac.config.mjs`](examples/qvac.config.mjs).

## The defaults, and why

### Model

`core.model: 'auto'` picks by memory: `Qwen3.5-9B-Q4_K_M` with 16 GB or more, `Qwen3.5-4B-Q4_K_M`
with 8 GB or more, and `Qwen3.5-2B-Q4_K_M` below that. It is the largest one that leaves the
machine room to work. Any model name you set wins.

### In a project

A project is the nearest folder, going up from where you start, that holds `.git`,
`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` or `deno.json`. Your home folder and `/`
never count, since both hold stray manifests and dotfiles.

In a project, `qvac` is set up to code:

| Key                          | Default                                                   | Why                                                                     |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `core.folders`               | `[{ path: <root>, write: true }]`                         | the agent can read and edit the project, and nothing else               |
| `core.agent.instructions`    | a short coding workflow                                   | explore first, plan multi-step work, edit precisely, test, summarise    |
| `core.agent.reasoning`       | `'enabled'` for a 9B or larger model                      | small models think slowly for little gain; larger ones plan better      |
| `harness.maxToolRounds`      | `40`                                                      | real coding tasks take many tool calls                                  |
| `harness.reasoningBudget`    | unset (the model's own)                                   | caps each round's thinking in tokens; `0` turns it off for every round  |
| `harness.thinking`           | unset (every round)                                       | `'plan'`: think after your message or a failed step, act without        |
| `harness.plugins`            | `coding`, the platform sandbox, and `lsp` (optional)      | a shell whose file access is confined to the policy                     |
| `harness.policy.files.write` | `[<root>]`                                                | writes stay inside the project                                          |
| `harness.policy.files.read`  | the project, toolchain folders that exist, `~/.gitconfig` | builds can find their compilers; your keys stay out of reach            |
| `harness.policy.network`     | `mode: 'on'`                                              | installs, web search and fetches work; limit it when a project needs to |

The coding workflow tells the model to: explore with `glob`, `grep` and `read_file` first; keep a
plan with `update_plan` for multi-step work; edit with `edit_file`, adding text by quoting a unique
neighbouring line in `old` and repeating it with the addition in `new` (never an empty `old`); use
`write_file` only for new files or full rewrites; run the tests or linter after a change; stop and
explain when the same call fails twice; and finish with a short summary. The exact text is
`CODING_INSTRUCTIONS` in `src/lib/runtime/agent-profile.ts`.

The plugins by platform:

| Platform | Plugins                                                           |
| -------- | ----------------------------------------------------------------- |
| macOS    | `coding`, `sandbox-macos`, `lsp`                                  |
| Linux    | `coding`, `sandbox-linux`, `lsp`                                  |
| Windows  | `sandbox-windows`, `lsp` (the Windows sandbox cannot host coding) |

`lsp` is optional: with no language server on `PATH` it shows as `skipped`, not `failed`.

The toolchain folders read when present are `/opt/homebrew`, `/usr/local`, `~/.nvm`, `~/.cargo`,
`~/.rustup`, `~/.pyenv`, `~/.bun`, `~/.deno`, and the Xcode developer folder `xcode-select`
chose. `~/.ssh`, `~/.aws` and the rest of your home folder are never on the list.

A toolchain that keeps a cache outside the project, such as Go's build cache, fails under the
sandbox until you let the shell write there. Give the sandbox plugin absolute `writable` folders;
the file tools never see them:

```json
{
  "harness": {
    "plugins": [
      { "id": "sandbox-macos", "options": { "writable": ["/Users/you/Library/Caches/go-build"] } }
    ]
  }
}
```

`go env GOCACHE` prints the folder. On Linux the id is `sandbox-linux`.

The network is open by default, as in Claude Code: the sandbox confines what the shell can read
and write, not where it connects. To limit it to a list of hosts, see
[Examples](#examples). A list holds only on macOS, through
`egress-proxy` under the macOS sandbox; bubblewrap and AppContainer can only turn the network on or
off.

### Outside a project

No folders, `maxToolRounds: 20`, the stock agent instructions, and no coding plugins. Turn any of
them on in `qvac.config` or `/plugins`.

### Nothing runs without the sandbox

If a sandbox the config asks for fails to start (or, under a host list, the egress proxy), Core
refuses every run, delegated runs included, with `The sandbox did not start (<reason>)`. `/plugins`
says `Runs refused: sandbox unavailable (<reason>)`, and the plugin's entry in
`cli-host-status.json` has `shellBlocked: true`. Fix the sandbox, or turn it off in `qvac.config`:
leave it out of `harness.plugins`, or set `harness.allowUnsandboxedShell: true` to run with no
confinement.

## Merge rules

- **Objects merge recursively; your value wins** at every key you set.
- **Arrays replace whole.** A `hosts` list, `files.read`, or `core.folders` you set is the list.
- **`harness.plugins` merges by `id`** (or `use` for a module plugin). An entry with a default's id
  merges into it, options included. `{ id, enabled: false }` removes a default.
- **`defaults: false`** at the top level skips the built-ins: only your file counts.
- **Folders you grant are covered.** When you set `core.folders` and keep the default policy, the
  policy's read and write lists widen to include them.
- **`plugins.json` goes last.** Its `enabled` list adds catalog plugins and its `disabled` list
  removes them, defaults included. That is what `space` in `/plugins` writes. A file from before
  `disabled` existed still reads.

## Every key

### Top level

| Key        | Default | Means                                                    |
| ---------- | ------- | -------------------------------------------------------- |
| `defaults` | `true`  | `false` skips the built-in defaults                      |
| `plugins`  | —       | SDK inference plugins, unchanged from the QVAC SDK's CLI |

### `core`

| Key                      | Default                             | Means                                                                                                                             |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `model`                  | `'auto'`                            | a model name, or `auto` to pick by memory; a name here or in `--model` is set on this device's agent at every start               |
| `dataDir`                | `~/.qvac/cli`                       | storage for the device, chats and plugin state (`--storage` overrides)                                                            |
| `modelsDir`              | the SDK's cache                     | where model files are kept                                                                                                        |
| `deviceName`             | the hostname (macOS: Computer Name) | how this device shows to your other devices (`--device-name`); setup offers it to keep or edit                                    |
| `accountName`            | `$USER`, asked once                 | your account's name, which people in your workspaces see (`--account-name`); setup offers it to keep or edit                      |
| `autoDownloadModels`     | `true`                              | `false` never downloads a model unasked                                                                                           |
| `agentId`                | this device's default               | the agent `qvac` configures and talks to                                                                                          |
| `folders`                | the project, writable               | `[{ path, write }]` or paths (read-only) the agent may use                                                                        |
| `agent.instructions`     | the coding workflow                 | the agent's bio; see below                                                                                                        |
| `agent.name`             | `QV.AC`                             | the agent's name                                                                                                                  |
| `agent.reasoning`        | `'enabled'` for 9B+                 | `'inherit'`, `'enabled'` or `'disabled'`                                                                                          |
| `agent.approvalMode`     | —                                   | `'ask'`, or `'skip-all'` to run writes without asking                                                                             |
| `agent.ctxSize`          | —                                   | the agent's context size in tokens                                                                                                |
| `agent.disabledToolsets` | `['exec']` with the coding shell    | toolsets the agent is not offered; the default adds to what `/tools` hid, a list here is the whole list (`[]` brings `exec` back) |

`core.agent` is written to the agent when Core starts, and only the fields that differ are sent.
The instructions replace the agent's bio only when that bio is one `qvac` set (a stock bio or the
coding workflow), or when `core.agent.instructions` is in your file. A bio you wrote yourself in
the app stays.

### `harness`

| Key                     | Default                    | Means                                                                                        |
| ----------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `maxToolRounds`         | `40` in a project, else 20 | tool rounds a top-level run may take; a run that sets its own keeps it                       |
| `plugins`               | see above                  | `{ id }` for a catalog plugin, `{ use, export, options, read }` for one                      |
| `policy`                | see above                  | the access policy every run is held to                                                       |
| `allowUnsandboxedShell` | `false`                    | `true` runs with no confinement when the sandbox fails to start                              |
| `planMode`              | —                          | `true` starts every run in plan mode                                                         |
| `llm`                   | —                          | the harness model settings, such as `{ contextSize }`                                        |
| `delegation`            | local subagents            | `{ enabled, slots, maxExternal, targets, read }`; targets need `name`, `protocol`, `command` |

Plugin entries are described in [Plugins](plugins.md#qvacconfig). `optional: true` makes a plugin
that cannot start show as `skipped`.

`policy` is the harness's `AccessPolicy` (`node_modules/@qvac/harness/lib/contract/policy.ts`). It is one
layer under the harness ceiling and the agent's own policy, and a narrower layer never widens:

```js
policy: {
  preset: 'workspace-write',         // or 'read-only', 'full'
  files: { read: ['/path'] | 'all', write: ['/path'], deny: ['/path'] },
  network: { mode: 'off' | 'hosts' | 'on', hosts: ['example.com', '*.example.com'] },
  exec: { allow: ['git'], deny: ['rm'] },
  env: ['PATH', 'HOME'],
  rules: [{ decision: 'deny', command: ['git', 'push'] }]
}
```

### `tui`

| Key           | Default      | Means                                                                   |
| ------------- | ------------ | ----------------------------------------------------------------------- |
| `startPage`   | `'chat'`     | the page `qvac` opens on                                                |
| `theme`       | `'terminal'` | the colour theme                                                        |
| `toolOutput`  | collapsed    | `'expanded'` shows tool output open                                     |
| `mouse`       | on           | `false` leaves the mouse to the terminal                                |
| `suggestions` | on           | `false` stops the suggested next message (one more model call per turn) |
| `extensions`  | `[]`         | [Extensions](extensions.md): commands, footer, keys and colours         |

## Examples

Turn off a default plugin:

```js
export default {
  harness: { plugins: [{ id: 'lsp', enabled: false }] }
}
```

Limit the network to a list of hosts (macOS only; `egress-proxy` enforces it, and plugins merge
by `id`, so this adds it to the defaults):

```js
export default {
  harness: {
    plugins: [{ id: 'egress-proxy' }],
    policy: {
      network: { mode: 'hosts', hosts: ['registry.npmjs.org', 'github.com', 'codeload.github.com'] }
    }
  }
}
```

Web tools such as `web_search` and `web_fetch` follow the same list, so add the hosts they need.

Use only what the file says:

```js
export default {
  defaults: false,
  core: { model: 'Qwen3.5-4B-Q4_K_M', folders: [{ path: '.', write: true }] },
  harness: { maxToolRounds: 30 }
}
```

Give a project its own instructions and a smaller model:

```js
export default {
  core: { model: 'Qwen3.5-4B-Q4_K_M', agent: { instructions: 'You maintain this Go service.' } }
}
```
