# Plugins

A plugin adds tools, hooks or services to the harness: the part of QV.AC that runs the model and
its tools on your device. `qvac` loads plugins when Core starts, so turning one on means a restart.
The `/plugins` screen does that for you in place. To change the terminal app itself (commands,
footer, keys, colours), write an [extension](extensions.md). With a 9B or larger model, QV.AC can
write a plugin for you: ask it, and its [`qvac-plugins` skill](skills.md) takes over.

In a project, `coding`, the platform sandbox and `lsp` are on by default. See
[Configuration](config.md) for the defaults, how they layer with `qvac.config` and `plugins.json`,
and how to turn one off.

- [What is built in](#built-in)
- [What you can turn on](#optional-plugins)
- [Turn plugins on](#turn-plugins-on): the screen, `plugins.json`, or `qvac.config`
- [MCP servers](#mcp-servers)
- [Check what loaded](#check-what-loaded)
- [Write your own](#write-your-own)

## Built in

Always loaded; nothing to turn on.

| Plugin      | Gives the model                                      |
| ----------- | ---------------------------------------------------- |
| Python      | `exec` with `language: "python"` (Pyodide)           |
| Obsidian    | `exec` routes for an Obsidian vault                  |
| Speech      | transcription and speech                             |
| Translation | on-device translation                                |
| Weather     | `weather_lookup`                                     |
| Web search  | `web_search`                                         |
| MCP         | `mcp_call`, for the MCP servers skills document      |
| Image       | `generate_image`, `edit_image` (with an image model) |
| Music       | `generate_music` (with a music model)                |

## Optional plugins

| id                | What it adds                                                                                               | Platforms    | Needs, and what comes with it                        | Options                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| `coding`          | `shell` and `shell_jobs`: a persistent shell with background jobs for real coding work                     | macOS, Linux | a sandbox: brings `sandbox-macos` or `sandbox-linux` | —                                                              |
| `sandbox-macos`   | Runs every shell line under Seatbelt with the run's file and network policy                                | macOS        | uses `egress-proxy` if it is on                      | —                                                              |
| `sandbox-linux`   | Runs every shell line under bubblewrap and seccomp                                                         | Linux        | `/usr/bin/bwrap`                                     | —                                                              |
| `sandbox-windows` | Runs `exec` shell lines in an AppContainer. Confines `exec` only; `coding` cannot use it                   | Windows      | —                                                    | —                                                              |
| `sandbox-vm`      | Runs `exec` shell lines in a barevisor VM with no network, disk or host mounts                             | macOS, Linux | a prebuilt guest                                     | `image: { kernel, initrd }` (required)                         |
| `egress-proxy`    | A per-session loopback proxy: sandboxed lines reach only the hosts the policy allows                       | all          | —                                                    | —                                                              |
| `lsp`             | `lsp`: definitions, references, symbols, hover and diagnostics from local language servers                 | all          | a language server on `PATH`                          | `servers: [{ language, command, args, extensions }]`           |
| `quickjs`         | `exec` with `language: "javascript"`: in-process, no files, network or modules                             | all          | —                                                    | —                                                              |
| `code-mode`       | `run_code`: one JavaScript body that calls the other tools as functions, each call still approved          | all          | brings `quickjs`                                     | —                                                              |
| `command-hooks`   | Runs the command hooks of a Claude Code `settings.json` (PreToolUse, PostToolUse, Stop, …)                 | all          | —                                                    | `settings` (default `~/.claude/settings.json`), `hooks`, `cwd` |
| `language-hint`   | Tells the model a non-English prompt's language, with the prompt in English                                | all          | built-in translation                                 | —                                                              |
| `walkie-talkie`   | `ask_team`, `team_send`, `team_wait`: messages between agents and people on other machines over Hyperswarm | all          | —                                                    | `team` (64 hex chars, shared with the team), `name` (required) |

`lsp` looks for `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer` and
`clangd` on `PATH`. A Mac app launched from the Dock has a short `PATH`, so list servers yourself
when it reports none found:

```json
{
  "options": {
    "lsp": {
      "servers": [
        {
          "language": "typescript",
          "command": "/opt/homebrew/bin/typescript-language-server",
          "args": ["--stdio"],
          "extensions": [".ts", ".mjs"]
        }
      ]
    }
  }
}
```

`command-hooks` runs commands from a settings file on your machine at each hook phase. Read that
file before you turn it on.

## Turn plugins on

### In the app

`/plugins`, then:

| Key     | Does                                                                |
| ------- | ------------------------------------------------------------------- |
| `space` | turn the plugin on or off; what it needs comes with it              |
| `enter` | details: what it does, its tools, what it needs, its last error     |
| `r`     | restart Core to apply your changes (a few seconds; your chat stays) |
| `m`     | add an MCP server                                                   |

Each row's badge says where it stands: `ready`, `failed`, `restart to apply`, `on with Coding`, or
`not on <platform>`.

### `plugins.json`

What the screen writes, in your storage folder (`~/.qvac/cli/plugins.json`, or `--storage`). Edit it
by hand if you like; it is read on every Core start. `enabled` turns catalog plugins on, and
`disabled` turns them off, including the ones the defaults or `qvac.config` turn on. Turning a
default off with `space` writes it to `disabled`.

```json
{
  "enabled": ["code-mode"],
  "disabled": ["lsp"],
  "options": {
    "walkie-talkie": { "team": "<64 hex chars>", "name": "laptop" }
  },
  "mcp": { "servers": [] }
}
```

### `qvac.config`

For plugins that are not in the catalog, or to pin one for a project. `use` is a package specifier
or a path relative to the config file.

```js
export default {
  harness: {
    plugins: [
      {
        use: '@qvac/harness/plugins/lsp',
        export: 'LspPlugin',
        options: { servers: [] },
        read: ['lsp']
      },
      {
        use: './plugins/greeter.mjs',
        export: 'Greeter',
        options: { greeting: 'Hi' },
        read: ['greet']
      },
      { use: 'qvac-plugin-notes', options: { dir: '~/notes' }, enabled: false }
    ]
  }
}
```

| Field     | Means                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `use`     | the module                                                                                                   |
| `export`  | a named plugin class to construct with `options`; without it the module's default export is used             |
| `options` | the plugin's own options                                                                                     |
| `read`    | your grant: tools listed here run without asking. A tool left out asks on every call, whatever it says it is |
| `id`      | a name for it in `/plugins` and the status file; a config entry with a catalog id replaces that entry        |
| `enabled` | `false` keeps the entry without loading it                                                                   |

Config plugins load first, then the catalog ones from `plugins.json`.

### Inline, in a JS config

A `qvac.config.mjs` or `qvac.config.js` can import a plugin and list the plugin itself,
`new Greeter({ greeting: 'Hi' })`, in place of a `use` entry. Wrap it in `{ plugin }` to give it
`read`, `optional` or `enabled`:

```js
import { Greeter } from './plugins/greeter.mjs'

export default {
  harness: {
    plugins: [{ plugin: new Greeter({ greeting: 'Hi' }), read: ['greet'] }]
  }
}
```

An inline plugin is known by its `name`, so `{ id: 'greeter', enabled: false }` in the same list
turns it off, and `qvac config` shows it as `harness.plugins.greeter = inline · config`.

The harness runs under Bare, not Node, so it imports the config file again there to build these.
For inline plugins the whole config must load under Bare: import `fs` or `path`, not `node:fs`. A
config that does not load fails its inline plugins with that error; the rest still start. Node
imports it first, so `@qvac/harness/...` must resolve from the config's folder too.

## MCP servers

Add one with `m` in `/plugins` (`name https://url`), or in `plugins.json`:

```json
{ "mcp": { "servers": [{ "name": "docs", "url": "https://mcp.example.com/mcp", "defer": true }] } }
```

| Field   | Means                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------- |
| `name`  | lowercase letters, digits, `_` and `-`; the tools appear as `<name>__<tool>`                       |
| `url`   | `https` (or `http`) Streamable HTTP endpoint                                                       |
| `auth`  | `{ "tokenCredentialKey": "..." }`: send that stored credential as a bearer token, only to this URL |
| `defer` | list the tools by name until the model loads them with `tool_search`; keeps a big server cheap     |

Harness v1 speaks Streamable HTTP only: there is no stdio transport, and localhost or private hosts
are refused.

## Check what loaded

The `/plugins` badges come from `cli-host-status.json` in your storage folder, which Core rewrites on
every start:

```json
{
  "plugins": [
    {
      "id": "lsp",
      "name": "Language servers",
      "state": "ready",
      "tools": ["lsp"],
      "source": "default"
    }
  ]
}
```

`state` is `ready`, `failed` (with `error`), or `skipped` (not on this platform, a dependency did
not start, or an optional plugin such as `lsp` found nothing to run). `source` is `default`,
`config` or `plugins.json`. When a sandbox fails, its entry has `shellBlocked: true` and the
top-level `shell` says `{ "blocked": true, "reason": "..." }`: every run is refused until it starts
(see [Configuration](config.md#nothing-runs-without-the-sandbox)). A failed plugin never stops the others or Core. The harness's own log is
`<storage>/harness.log`.

## Write your own

A plugin is a class with a `name`, the plugin `api` version and a `setup` that returns what it
adds. This one gives the model a `greet` tool:

```js
// plugins/greeter.mjs
import { PluginRegistry } from '@qvac/harness/plugins'

export class Greeter {
  constructor(options = {}) {
    this.name = 'greeter'
    this.api = PluginRegistry.API_VERSION
    this.greeting = options.greeting || 'Hello'
  }

  setup() {
    return {
      tools: [
        {
          name: 'greet',
          description: 'Greet someone by name.',
          toolset: 'team',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Who to greet' } },
            required: ['name']
          },
          effect: () => 'read',
          execute: (args) => Promise.resolve({ content: `${this.greeting}, ${args.name}!` })
        }
      ]
    }
  }
}
```

List it in `qvac.config` with `{ use: './plugins/greeter.mjs', export: 'Greeter', options: { greeting: 'Hi' }, read: ['greet'] }`
and start `qvac`. It shows in `/plugins` as `greeter · ready`. The file is
[`docs/plugins/greeter.mjs`](plugins/greeter.mjs).

What `setup` can return:

| Field          | For                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools`        | tools the model calls. Each has `name`, `description`, a JSON-schema `parameters`, `effect(args)` → `'read'` or `'write'`, `execute(args, ctx)`, and a `toolset`: one of `web-search`, `knowledge`, `files`, `exec`, `http-request`, `mcp-call`, `image`, `music`, `coding`, `team`. The toolset is the switch `/tools` turns it off with, and the harness refuses any other value. A write goes to the user's approval with its `quote`, the line they read before saying yes |
| `hooks`        | `{ name, phase, matcher, run(ctx) }` on `runStart`, `preToolCall`, `postToolCall`, `toolFailure`, `runEnd`, `stop`, … A hook can `deny` or `ask`, never `allow`, and can replace a result the model reads                                                                                                                                                                                                                                                                      |
| `services`     | named services other plugins `needs`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `capabilities` | invoke-only tools the model never sees                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `exec`         | `exec` languages, routes or a shell                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `skills`       | readiness for a skill the harness already ships                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `teardown`     | cleanup; or register it with `ctx.onDispose` in `setup`                                                                                                                                                                                                                                                                                                                                                                                                                        |

The plugin object can also declare `provides`, `needs` and `wants` (services, which order startup),
`validate()` (return a string to refuse bad options, and the plugin is left out with that reason), and
`addons` for native code.

Rules worth knowing:

- `read` is the user's grant, not the plugin's. Never set it yourself; the host copies it on.
- Tools run in the harness worker, the same process as the model. Keep them fast, and do slow work
  in `execute`, not in `setup`.
- A name that clashes with another plugin's tool or service fails that plugin's start.

The harness has a full worked example, with a service, a hook, owned cleanup and packaging as its
own `qvac-plugin-<name>` package: `examples/custom-plugin/` in the
[harness repo](https://github.com/tetherto/qvac-harness/tree/dev/examples/custom-plugin) (its
`README` walks through it). The plugin framework's rules are in its `lib/plugins/README.md`.
