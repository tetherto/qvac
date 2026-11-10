const time = (seconds) =>
  new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: seconds ? '2-digit' : undefined
  })

// lunte-disable-next-line qvac/no-default-export -- a `use` module's default export is the plugin
export default function clock(options = {}) {
  return {
    name: 'clock',
    footer: () => time(options.seconds),
    commands: [
      {
        name: 'time',
        description: 'Show the time, or put it in the composer with /time insert',
        run: (ctx, args) => (args === 'insert' ? ctx.insert(time(true)) : `It is ${time(true)}`)
      }
    ],
    keys: {
      'alt+t': (ctx) => ctx.notice(`It is ${time(true)} · ${ctx.model ?? 'no model yet'}`)
    }
  }
}
