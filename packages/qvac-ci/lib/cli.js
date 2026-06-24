// Minimal CLI builder for qvac-ci — no external dependencies.

export function header (text) {
  return { type: 'header', text }
}

export function summary (text) {
  return { type: 'summary', text }
}

export function footer (text) {
  return { type: 'footer', text }
}

export function flag (spec, description) {
  return { type: 'flag', spec, description }
}

function toCamelCase (name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function parseFlagSpec (spec) {
  const match = spec.match(/^(--[\w-]+)(?:\|(-[\w]))?(?:\s+(<[^>]+>|\[[^\]]+\]))?$/)
  if (!match) {
    throw new Error('Invalid flag spec: ' + spec)
  }

  const longName = match[1].slice(2)
  const shortName = match[2] ? match[2].slice(1) : null
  const valuePart = match[3] || null
  const valueRequired = valuePart ? valuePart.startsWith('<') : false
  const valueOptional = valuePart ? valuePart.startsWith('[') : false

  return { longName, shortName, valuePart, valueRequired, valueOptional, hasValue: Boolean(valuePart) }
}

function buildHelp (cmd) {
  const lines = []
  for (const part of cmd.decorators) {
    if (part.type === 'header') lines.push(part.text)
    if (part.type === 'summary') lines.push(part.text)
  }
  lines.push('')
  const cmdPart = cmd.subcommands.length > 0 ? ' [command]' : ''
  lines.push('Usage: ' + cmd.name + cmdPart + ' [options]')
  lines.push('')

  if (cmd.subcommands.length > 0) {
    lines.push('Commands:')
    for (const sub of cmd.subcommands) {
      const summaryLine = sub.decorators.find(d => d.type === 'summary')
      lines.push('  ' + sub.name + (summaryLine ? '  ' + summaryLine.text : ''))
    }
    lines.push('')
  }

  if (cmd.flagDefs.length > 0) {
    lines.push('Options:')
    for (const f of cmd.flagDefs) {
      const parsed = parseFlagSpec(f.spec)
      const long = '--' + parsed.longName
      const short = parsed.shortName ? ', -' + parsed.shortName : ''
      const val = parsed.valuePart ? ' ' + parsed.valuePart : ''
      lines.push('  ' + long + short + val + '  ' + f.description)
    }
    lines.push('')
  }

  const footerPart = cmd.decorators.find(d => d.type === 'footer')
  if (footerPart && footerPart.text) {
    lines.push(footerPart.text)
    lines.push('')
  }

  return lines.join('\n')
}

function parseFlags (argv, flagDefs) {
  const parsed = {}
  const specs = flagDefs.map(f => ({ ...parseFlagSpec(f.spec), description: f.description }))

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      return { help: true, flags: parsed }
    }

    let matched = null
    for (const spec of specs) {
      if (arg === '--' + spec.longName) {
        matched = spec
        break
      }
      if (spec.shortName && arg === '-' + spec.shortName) {
        matched = spec
        break
      }
    }

    if (!matched) {
      if (arg.startsWith('-')) {
        throw new Error('Unknown option: ' + arg)
      }
      break
    }

    if (!matched.hasValue) {
      parsed[matched.longName] = true
      parsed[toCamelCase(matched.longName)] = true
      continue
    }

    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      parsed[matched.longName] = next
      parsed[toCamelCase(matched.longName)] = next
      i++
    } else if (matched.valueRequired) {
      throw new Error('Option --' + matched.longName + ' requires a value')
    }
  }

  return { help: false, flags: parsed }
}

function isSubcommand (item) {
  return item && typeof item === 'object' && typeof item.name === 'string' && Array.isArray(item.flagDefs)
}

export function command (name, ...items) {
  const decorators = []
  const flags = []
  const subcommands = []
  let handler = null

  for (const item of items) {
    if (typeof item === 'function') {
      handler = item
    } else if (item?.type === 'flag') {
      flags.push(item)
    } else if (item?.type) {
      decorators.push(item)
    } else if (isSubcommand(item)) {
      subcommands.push(item)
    }
  }

  const cmd = {
    name,
    decorators,
    flagDefs: flags,
    subcommands,
    handler,
    flags: {},

    parse (argv = process.argv.slice(2)) {
      if (subcommands.length > 0) {
        const subName = argv[0]
        if (!subName || subName.startsWith('-')) {
          const { help, flags: rootFlags } = parseFlags(argv, flags)
          cmd.flags = rootFlags
          if (help) {
            process.stdout.write(buildHelp(cmd) + '\n')
            return
          }
          if (handler) {
            return handler()
          }
          process.stderr.write('Missing command. Run with --help for usage.\n')
          process.exit(1)
        }

        const sub = subcommands.find(s => s.name === subName)
        if (!sub) {
          process.stderr.write('Unknown command: ' + subName + '\n')
          process.exit(1)
        }

        return sub.parse(argv.slice(1))
      }

      const { help, flags: parsedFlags } = parseFlags(argv, flags)
      cmd.flags = parsedFlags

      if (help) {
        process.stdout.write(buildHelp(cmd) + '\n')
        return
      }

      if (handler) {
        return handler()
      }
    }
  }

  return cmd
}
