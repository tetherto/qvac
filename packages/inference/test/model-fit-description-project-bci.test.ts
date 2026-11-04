import test from 'brittle'
import crypto from 'bare-crypto'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import type { BciFitRequest, BciFitResult } from '@qvac/bci-whispercpp'

import { BCI_EMBEDDER, BCI_WINDOWED } from '@/models/registry/index'
import { getPlugin, registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { bciPlugin } from '@/plugins/builtin/bci-whispercpp-transcription/plugin'
import { ModelType } from '@/schemas/index'
import { projectFitFromLoad } from '@/model-fit/description/project'
import type { FitBlobBinding, FitStubEntry } from '@/model-fit/description/fetch'
import type { FitProbeRequest } from '@/model-fit/run/engine'
import type { FitRunResult } from '@/model-fit/run/run'

/**
 * The projection `assessModelFit` runs for a BCI load before download: the
 * registry's weightless descriptions, resolved through the BCI plugin, and the
 * request its fitter is handed. The fitter is the addon's, so a stand-in reports
 * what it was pointed at and answers the way `@qvac/bci-whispercpp` 0.11.0
 * documents: with no `embedderPath` it reads `bci-embedder.bin` beside the
 * model, it counts the host RAM the embedder keeps in `hostBytes`, and an
 * embedder it cannot read is an `error` with reason `embedder-unreadable`.
 */

const EMBEDDER_FILENAME = 'bci-embedder.bin'

const MODEL_DESCRIPTION = Buffer.from('GGUF' + 'bci-whisper-description')
const EMBEDDER_DESCRIPTION = Buffer.from('GGUF' + 'bci-embedder-description')

const MIB = 1024 * 1024
const DEVICE_BYTES = 300 * MIB
const WHISPER_HOST_BYTES = 20 * MIB
const EMBEDDER_BYTES = 60 * MIB

const LOAD_CONFIG = {
  whisperConfig: { language: 'en', temperature: 0.0 },
  bciConfig: { day_idx: 1 }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha-256').update(bytes).digest('hex')
}

function bindingFor(bytes: Buffer): FitBlobBinding {
  return {
    coreKey: 'c'.repeat(64),
    blockOffset: 0,
    blockLength: 1,
    byteOffset: 0,
    byteLength: bytes.length,
    sha256: sha256(bytes)
  }
}

/**
 * Stands in for the registry: a record per registry path, each carrying a
 * description unless it is listed in `undescribed`, and a blob store that
 * writes the description a binding names.
 */
function registry(undescribed: readonly string[] = []) {
  const described = new Map<string, Buffer>([
    [BCI_WINDOWED.registryPath, MODEL_DESCRIPTION],
    [BCI_EMBEDDER.registryPath, EMBEDDER_DESCRIPTION]
  ])
  const byDigest = new Map([...described.values()].map((bytes) => [sha256(bytes), bytes]))

  return {
    getEntry: async (registryPath: string): Promise<FitStubEntry | null> => {
      if (!described.has(registryPath)) return null
      if (undescribed.includes(registryPath)) return {}
      return { fitBlobBinding: bindingFor(described.get(registryPath)!) }
    },
    downloadBlob: async (binding: FitBlobBinding, outputFile: string) => {
      fs.writeFileSync(outputFile, byDigest.get(binding.sha256)!)
    }
  }
}

function readIfPresent(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file).toString() : undefined
}

interface Seen {
  request: BciFitRequest
  model: string | undefined
  embedder: string | undefined
}

function bciResult(embedderReadable: boolean): BciFitResult {
  const embedderBytes = embedderReadable ? EMBEDDER_BYTES : 0
  return {
    status: embedderReadable ? 'fits' : 'error',
    reason: embedderReadable ? 'fits' : 'embedder-unreadable',
    modelType: 'base',
    deviceName: 'Metal',
    deviceIsCpu: false,
    deviceSharesHostMemory: true,
    deviceFreeBytes: 8 * 1024 * MIB,
    deviceTotalBytes: 16 * 1024 * MIB,
    deviceBytes: DEVICE_BYTES,
    weightsBytes: 200 * MIB,
    kvBytes: 60 * MIB,
    computeBytes: 40 * MIB,
    hostOverflowBytes: 0,
    hostBytes: WHISPER_HOST_BYTES + embedderBytes,
    embedderBytes,
    report: 'table'
  }
}

/**
 * The addon's side of the contract, read off the files it is pointed at while
 * they are still staged.
 */
function bciFitter() {
  const seen: Seen[] = []
  const runFit = async (probe: FitProbeRequest): Promise<FitRunResult> => {
    if (probe.engine !== 'bci-whispercpp') throw new Error(`unexpected engine ${probe.engine}`)

    const { request } = probe
    const embedderPath =
      request.embedderPath ?? path.join(path.dirname(request.modelPath), EMBEDDER_FILENAME)
    const embedder = readIfPresent(embedderPath)
    seen.push({ request, model: readIfPresent(request.modelPath), embedder })

    return {
      status: 'completed',
      probe: { engine: 'bci-whispercpp', result: bciResult(embedder !== undefined) }
    }
  }
  return { seen, runFit: runFit as never }
}

interface Teardown {
  teardown: (fn: () => void) => void
}

/**
 * Puts the builtin BCI plugin in the registry for one test and leaves the
 * registry as it found it, whatever another file registered.
 */
function useBciPlugin(t: Teardown): void {
  const previous = getPlugin(ModelType.bciWhispercppTranscription)
  if (previous !== undefined) unregisterPlugin(previous.modelType)
  registerPlugin(bciPlugin)
  t.teardown(() => {
    unregisterPlugin(bciPlugin.modelType)
    if (previous !== undefined) registerPlugin(previous)
  })
}

function scratchDir(t: Teardown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-bci-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function project(
  modelConfig: Record<string, unknown>,
  options: {
    cacheDir: string
    registry: ReturnType<typeof registry>
    runFit: never
    availableBytes?: number
  }
) {
  return projectFitFromLoad(
    {
      modelSrc: BCI_WINDOWED,
      modelType: ModelType.bciWhispercppTranscription,
      modelConfig
    },
    BCI_WINDOWED.name,
    {
      stub: {
        cacheDir: options.cacheDir,
        getEntry: options.registry.getEntry,
        downloadBlob: options.registry.downloadBlob
      },
      fit: {
        runFit: options.runFit,
        residentModelBytes: async () => 0,
        availableSystemBytes: async () => options.availableBytes,
        // A device that shares system RAM, where host bytes compete with it.
        countsDeviceRows: async () => true
      }
    }
  )
}

test('bci fit: the embedder description is staged beside the model description', async (t) => {
  useBciPlugin(t)
  const cacheDir = scratchDir(t)
  const { seen, runFit } = bciFitter()

  const outcome = await project(LOAD_CONFIG, { cacheDir, registry: registry(), runFit })

  t.is(seen.length, 1, 'the BCI fitter was asked once')
  t.is(seen[0]?.model, MODEL_DESCRIPTION.toString(), 'the model path is its description')
  t.absent(seen[0]?.request.embedderPath, 'no path, so the fitter reads beside the model')
  t.is(seen[0]?.embedder, EMBEDDER_DESCRIPTION.toString(), 'the embedder is its description')

  t.is(outcome.status, 'projected')
  if (outcome.status !== 'projected') return
  t.is(outcome.fit.engine, 'bci-whispercpp')
  t.is(outcome.fit.verdict, 'fit')
  t.is(outcome.fit.projection?.hostBytes, WHISPER_HOST_BYTES + EMBEDDER_BYTES)
  t.alike(fs.readdirSync(cacheDir), [], 'nothing staged outlives the projection')
})

// The embedder alone takes the load past what the machine has free, so the
// verdict turns on its bytes being in the projection.
test('bci fit: the embedder host RAM counts against the machine budget', async (t) => {
  useBciPlugin(t)
  const { runFit } = bciFitter()
  const withoutEmbedder = DEVICE_BYTES + WHISPER_HOST_BYTES

  const outcome = await project(LOAD_CONFIG, {
    cacheDir: scratchDir(t),
    registry: registry(),
    runFit,
    availableBytes: withoutEmbedder + EMBEDDER_BYTES / 2
  })

  t.is(outcome.status, 'projected')
  if (outcome.status !== 'projected') return
  t.is(outcome.fit.verdict, 'does-not-fit')
  t.is(outcome.fit.reason, 'exceeds-available-memory')
})

test('bci fit: an embedder with no description leaves the fitter without a verdict', async (t) => {
  useBciPlugin(t)
  const { seen, runFit } = bciFitter()

  const outcome = await project(LOAD_CONFIG, {
    cacheDir: scratchDir(t),
    registry: registry([BCI_EMBEDDER.registryPath]),
    runFit
  })

  t.is(seen[0]?.model, MODEL_DESCRIPTION.toString())
  t.absent(seen[0]?.embedder, 'nothing was staged beside the model')

  t.is(outcome.status, 'projected')
  if (outcome.status !== 'projected') return
  t.is(outcome.fit.verdict, 'unknown')
  t.is(outcome.fit.reason, 'embedder-unreadable')
  t.absent(outcome.fit.projection, 'an engine error carries no figures')
})

test('bci fit: a named embedder source is fitted from its own description', async (t) => {
  useBciPlugin(t)
  const { seen, runFit } = bciFitter()

  const outcome = await project(
    { ...LOAD_CONFIG, embedderModelSrc: BCI_EMBEDDER },
    { cacheDir: scratchDir(t), registry: registry(), runFit }
  )

  const embedderPath = seen[0]?.request.embedderPath
  t.ok(embedderPath, 'the resolved embedder travels as its own path')
  t.not(path.dirname(embedderPath ?? ''), path.dirname(seen[0]?.request.modelPath ?? ''))
  t.is(seen[0]?.embedder, EMBEDDER_DESCRIPTION.toString())

  t.is(outcome.status, 'projected')
  if (outcome.status !== 'projected') return
  t.is(outcome.fit.verdict, 'fit')
})
