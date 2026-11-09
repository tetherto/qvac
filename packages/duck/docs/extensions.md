# Extensions

An extension changes how the terminal app works: it adds `/` commands, a footer note, composer
keys or a colour shade. It runs in the TUI process, next to the screen, not in Core. Tools for the
agent are [harness plugins](plugins.md).

An extension is a plain object. Every field is optional except `name`:

```js
{
  name: 'clock',
  commands: [{ name: 'time', description: 'Show the time', run: (ctx, args) => 'It is noon' }],
  footer: (ctx) => '12:00',
  keys: { 'alt+t': (ctx) => ctx.notice('tick') },
  theme: { teal: '#20c0a0' }
}
```

## Adding one

List extensions under `tui.extensions` in `qvac.config.*`. They apply as soon as the file is
saved: `qvac` watches the config and every extension file it lists, and reloads them in place. A
file the config pulls in with `import` keeps its first version until `qvac` restarts, so list an
extension you are still editing with `use`. An
entry is one of:

- **The extension itself**, written inline in a `.js`, `.mjs` or `.ts` config. The TUI imports your
  config file again to reach it, so it can hold functions and class instances.
- **A path**, `'./ui/clock.mjs'`, or **`{ use, options }`**, resolved against the config file's
  folder. The module's default export is the extension, or a function that takes `options` and
  returns it (it may be async).

```js
// qvac.config.mjs
import clock from './ui/clock.mjs'

export default {
  tui: {
    extensions: [
      clock({ seconds: true }),
      { use: './ui/clock.mjs', options: { seconds: false } },
      { name: 'shade', theme: { teal: '#1fb89f' } }
    ]
  }
}
```

An extension that fails to load, or asks for something already taken, is named in a notice when chat
opens; the others still load.

## API

### `commands: [{ name, description, run(ctx, args) }]`

Each command shows in the `/` palette and in `/help`, its description followed by the extension's
name. `args` is the text after the command name. `run` may be async. A string it returns shows as
a notice, or in the panel when it has more than one line. A name a built-in command or prompt
template already uses is refused.

### `footer(ctx)`

A short string for the right of the footer's status line. It shows only while the full core hint
fits beside it, so on a narrow terminal it is the first thing to go. It is called on every frame:
keep it cheap and synchronous.

### `keys: { chord: (ctx) => … }`

Chat composer bindings, such as `'alt+t'` or `'ctrl+r'`. A key QV.AC already answers (`ctrl+b`,
`ctrl+k`, `tab`, a plain letter…) is refused rather than overridden. A handler may return a string,
as a command does. `/help` lists the keys an extension bound.

### `theme: { token: colour }`

Reshades existing colour tokens: `bg`, `text`, `muted`, `teal`, `green`, `purple`, `red`, `line`,
`select`, `added`, `removed`. A colour is `'#rrggbb'` or `'r;g;b'`. Tokens keep their roles, so
`teal` stays the brand and accent colour in a new shade; an unknown token is ignored with a notice.

### `ctx`

What extension code gets. Actions reach the app as messages, so they work from async code too:

| Member               | Does                                                    |
| -------------------- | ------------------------------------------------------- |
| `send(text)`         | sends `text` to the agent in this chat; the draft stays |
| `insert(text)`       | types `text` into the composer at the cursor            |
| `notice(text)`       | shows a one-line notice above the composer              |
| `show(title, lines)` | opens the panel with `title` and an array of lines      |
| `agent`              | `{ id, name, model }` of the chat's agent, or `null`    |
| `model`              | the agent's model name, or `null`                       |
| `chatId`             | the open conversation, or `null` for a new one          |
| `cwd`                | the folder `qvac` started in                            |

The read-only fields are read when you use them, so they are always current.

### Errors

A command, key or footer that throws shows `Extension <name> failed: <message>` as a notice, and
the TUI carries on. A footer that throws is turned off until restart.

## Example

[`docs/extensions/clock.mjs`](extensions/clock.mjs) puts the time in the footer, adds `/time` (and
`/time insert`), and binds `alt+t`:

```js
export default {
  tui: { extensions: [{ use: './docs/extensions/clock.mjs', options: { seconds: true } }] }
}
```
