---
name: qvac-plugins
description: Load this only when the user asks you to write or change their QV.AC setup — qvac.config, a plugin under plugins/ or an extension (a / command, key, footer note or colours). It is how-to text for that work; it gives you no tools and cannot run, build or test anything.
aliases: [plugin, plugins, extension, extensions]
platform: [darwin, linux, win32]
version: 3
# Shipped by the QV.AC CLI into the user skills folder. "high" is the 9B tier: smaller models do not get it.
# prettier-ignore
metadata: { "openclaw": { "minCapabilityProfile": "high" } }
---

# QV.AC plugins and extensions

## First decide: plugin or extension

|                | Plugin                               | Extension                                  |
| -------------- | ------------------------------------ | ------------------------------------------ |
| Who uses it    | the model: a tool it decides to call | the person: something they press or see    |
| What it adds   | tools (and hooks) for the agent      | `/` commands, keys, a footer note, colours |
| Where it lives | `harness.plugins` in qvac.config     | `tui.extensions` in qvac.config            |
| Apply a change | `/plugins`, then `r`                 | nothing: it applies when the file is saved |

- "a tool to roll dice", "look up our API", "let the agent query the database" → **plugin**
- "a /hello command", "a key that inserts my sign-off", "the git branch in the footer" →
  **extension**
- "a /standup command that asks the agent for a summary" → **extension** whose command calls
  `ctx.send(...)`

A plugin cannot add a `/` command or a key, and an extension cannot give the model a tool. If the
request is unclear, ask which one the user means before writing anything.

## Plugins: tools for the model

A plugin is one `.mjs` file that exports a class. QV.AC loads it when Core starts and gives the
model the tools its `setup()` returns.

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

Every tool needs all of: `name`, `description`, `toolset`, `parameters`, `effect`, `execute`.

| Field        | Write                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | `snake_case`, unique across all plugins                                                                                            |
| `toolset`    | exactly one of `web-search`, `knowledge`, `files`, `exec`, `http-request`, `mcp-call`, `image`, `music`, `coding`, `team`          |
| `parameters` | a JSON schema with `type: 'object'`                                                                                                |
| `effect`     | `() => 'read'` if it changes nothing, `() => 'write'` if it does                                                                   |
| `quote`      | write tools only: `(args) => 'Save note "x"'`, the line the user reads before approving                                            |
| `validate`   | optional `(args) => null` when fine, or an error string. The harness does not enforce `required`, so check required arguments here |
| `execute`    | `async (args, ctx) => result`: a string or a plain object the model reads                                                          |

### Turn a plugin on

List it under `harness.plugins` in `qvac.config.mjs` (create the file if there is none):

```js
export default {
  harness: {
    plugins: [
      {
        use: './plugins/greeter.mjs',
        export: 'Greeter',
        options: { greeting: 'Hi' },
        read: ['greet']
      }
    ]
  }
}
```

- `use`: the file, relative to the config file. `export`: the class name. `options`: what the
  constructor gets.
- `read`: tools that run without asking the user. Add a tool here only when the user says so.
- Or inline, when the user asks for it: `import { Greeter } from './plugins/greeter.mjs'` at the top
  and `plugins: [new Greeter({ greeting: 'Hi' })]`; to grant reads, `{ plugin: new Greeter(), read: ['greet'] }`.

Then tell the user: open `/plugins` and press `r`. That re-reads qvac.config and restarts Core.
The plugin shows as its own row, `ready` with its tools, or `failed` with the error under `enter`.

### Plugin mistakes

- `api` missing or not `PluginRegistry.API_VERSION`: the plugin does not start.
- A `toolset` not in the list above, or a tool name another plugin uses: it fails to start.
- `export` does not match the class name, or the class is not exported.
- Setting `this.read` in the plugin: `read` is the user's grant, set in qvac.config only.
- Slow work in `setup()`: do it in `execute`; `setup()` runs while Core starts.
- Imports the harness does not provide. A plugin runs under Bare and may import `fs`, `path`, `os`,
  `crypto`, `process`, `url`, `events` (no `node:` prefix), `@qvac/harness`,
  `@qvac/harness/plugins` and its own files. No `require`, no npm packages the project lacks.
- Hooks (`setup()` returning `hooks`) are for watching tool calls and runs, never for commands.

## Extensions: changes to the app

An extension is a plain object; only `name` is required. It runs in the terminal app and the model
never sees it.

```js
// qvac.config.mjs
export default {
  tui: {
    extensions: [
      {
        name: 'standup',
        commands: [
          {
            name: 'standup',
            description: 'Draft my standup',
            run: (ctx) => ctx.send('Summarise what changed in this project today in three bullets.')
          }
        ],
        footer: () => new Date().toLocaleTimeString()
      }
    ]
  }
}
```

- `commands`: `run(ctx, args)`, where `args` is the text after the command. Return a string to
  show it, or call `ctx.send(text)` (to the agent), `ctx.insert(text)` (into the composer),
  `ctx.notice(text)` or `ctx.show(title, lines)`.
- `keys: { 'alt+s': (ctx) => ... }`: only keys the app does not already use.
- `footer: (ctx) => 'text'`: a short note on the footer's right.
- `theme: { teal: '#1fb89f' }`: only existing colour names.
- When it grows, move it to its own file (`./ui/standup.mjs` with a default export) and list
  `'./ui/standup.mjs'`.

It applies as soon as the file is saved: `qvac` reloads extensions when qvac.config or an
extension file it lists changes. Tell the user to try the command. A problem shows as a notice
naming the extension.

### Extension mistakes

- Putting it under `harness.plugins`, or writing a plugin class for a `/` command: commands and keys
  are extensions.
- A command name the app already has (`/help`, `/model`, ...) or a key it uses: it is refused.
- Expecting the model to call it: only the person does.
