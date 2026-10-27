type Model = NonNullable<Awaited<ReturnType<Capabilities['listModels']>>['models']>[number]
type ModelArgs = { name?: string | undefined; options: RuntimeOptions; io: CommandIO }
import type { CommandIO } from '../../io.js'
import type { Capabilities } from '@qvac/core/client'
import type { RuntimeOptions } from '../../../lib/types.js'
import type { CoreHost } from '../../../lib/types.js'
import { CommandError } from '../../core.js'
import { bytes, table } from '../../format.js'
import { downloadMeter, progressReporter } from '../../progress.js'

export function models(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  const run = { list, pull, remove }[options.action as 'list' | 'pull' | 'remove']
  if (!run) throw new CommandError('Unknown model action', { code: 2 })
  return run(host.engine, { name: options.words[0], options, io })
}

const size = (model: Model) =>
  model.isCached ? (model.actualSize ?? model.expectedSize) : model.expectedSize

async function list(engine: Capabilities, { options, io }: ModelArgs) {
  const { models: rows, memory } = await engine.listModels({})
  const all = rows ?? []
  if (options.json) {
    io.json({ models: all.map(modelJson), memory: memory ?? null })
    return 0
  }

  const here = all.filter((m) => m.isCached)
  const catalog = all.filter((m) => !m.isCached)
  io.line('ON THIS DEVICE')
  io.lines(
    here.length
      ? indent(table(here.map((m) => [m.name, m.taskType ?? '', bytes(size(m)), state(m)])))
      : ['  none yet: qvac models pull <model>']
  )
  if (memory) {
    io.line(`  model memory: ${bytes(memory.usedBytes)} of ${bytes(memory.capBytes)} in use`)
  }

  io.line('')
  io.line('CATALOG (suits this device)')
  io.lines(indent(table(catalog.map((m) => [m.name, m.taskType ?? '', bytes(m.expectedSize)]))))

  return 0
}

function modelJson(m: Model) {
  return {
    name: m.name,
    taskType: m.taskType ?? null,
    onDisk: !!m.isCached,
    loaded: !!m.isLoaded,
    loading: !!m.isLoading,
    size: size(m),
    expectedSize: m.expectedSize,
    memoryBytes: m.memoryBytes ?? null
  }
}

function state(m: Model) {
  if (m.isLoading) return 'loading'
  if (m.isLoaded) {
    return `loaded${m.memoryBytes ? ` (${bytes(m.memoryBytes)} memory)` : ''}`
  }

  if (m.expectedSize && (m.actualSize ?? 0) < m.expectedSize) {
    return `partial, ${bytes(m.actualSize ?? 0)} so far`
  }

  return 'on disk'
}

const indent = (lines: string[]) => lines.map((line) => `  ${line}`)

async function pull(engine: Capabilities, { name, options, io }: ModelArgs) {
  // the suited list names the catalog; the full registry adds what does not suit this device
  const lists = await Promise.all([
    engine.listModels({}),
    engine.listModels({ fullRegistry: true })
  ])
  const model = lists.flatMap((list) => list.models ?? []).find((m) => m.name === name)
  if (!model) {
    throw new CommandError(`no model named ${name}. qvac models list shows the catalog.`, {
      code: 2
    })
  }

  if (complete(model)) {
    io.note(`${name} is already on this device.`)
    return 0
  }

  // Core fetches nothing for a device before its first-run setup, an explicit request included
  if (!(await engine.getConfig({})).onboardingCompleted) {
    throw new CommandError(
      'this device is not set up yet, and Core downloads nothing before setup. Run qvac serve first.'
    )
  }

  const done = await downloaded(engine, { name, options, io })
  if (!done) {
    io.note(`\nStopped. Run qvac models pull ${name} again to carry on.`)
    return 130
  }

  io.note(`${name} is on this device (${bytes(size(done))}).`)

  return 0
}

const complete = (m: Model) =>
  m.isCached && !(m.expectedSize && (m.actualSize ?? 0) < m.expectedSize)

function downloaded(engine: Capabilities, { name, options, io }: ModelArgs) {
  const catalog = engine.modelsWatch({ cachedOnly: true })
  const transfers = engine.modelDownloadsWatch({})
  const measure = downloadMeter()
  const report = progressReporter(options, io)
  const landed = new Promise<Model>((resolve, reject) => {
    catalog.on('data', ({ models: rows }) => {
      const model = (rows ?? []).find((m) => m.name === name)
      if (model && complete(model)) {
        resolve(model)
      }
    })
    transfers.on('data', ({ downloads }) => {
      const frame = (downloads ?? []).find((d) => d.name === name)
      if (!frame) {
        return
      }

      if (frame.phase === 'error') {
        reject(new CommandError(`download failed: ${frame.error || 'no reason given'}`))
      } else {
        report(measure(frame))
      }
    })
  })

  return Promise.race([
    landed,
    engine.retryModelDownload({ name: name! }).then(() => landed),
    io.stopping.then(() => null)
  ]).finally(() => {
    report.end()
    catalog.destroy()
    transfers.destroy()
  })
}

async function remove(engine: Capabilities, { name, options, io }: ModelArgs) {
  const { models: rows } = await engine.listModels({ cachedOnly: true })
  const model = (rows ?? []).find((m) => m.name === name)
  if (!model) {
    throw new CommandError(`${name} is not on this device. qvac models list shows what is.`, {
      code: 2
    })
  }

  if (model.isLoaded || model.isLoading) {
    throw new CommandError(
      `${name} is loaded in memory. Unload it (dashboard: 3, models) or stop what is using it first.`
    )
  }

  const { agents } = await engine.modelUsers({ name: name! })
  const users = [...new Set((agents ?? []).map((a) => a.agentName))]
  io.note(`${name} takes ${bytes(size(model))} on this device.`)
  if (users.length) {
    io.note(`Agents that use it will download it again: ${users.join(', ')}.`)
  }

  if (!(await io.confirm('Remove it?', { yes: options.yes }))) {
    io.note('Kept.')
    return 1
  }

  const { freedBytes } = await engine.deleteModel({ name: name! })
  io.note(`Removed ${name}, freed ${bytes(freedBytes)}.`)

  return 0
}
