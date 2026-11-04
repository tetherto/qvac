import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MUSIC_FIELD_CODES,
  audioEditBody,
  audioGenParams,
  audioGenerationBody,
  audioUnderstandingBody
} from '@/serve/extensions/default/schemas/music'
import { createMusicJobsStore, musicJobResource } from '@/serve/extensions/default/music-jobs-store'
import { tearDownMusicJob } from '@/serve/extensions/default/routes/music'
import { buildWavHeader } from '@/serve/extensions/openai/audio'
import { extensionErrorCodes } from '@/serve/core/extensions'
import openaiExtension from '@/serve/extensions/openai'
import defaultExtension from '@/serve/extensions/default'
import type { QvacContext } from '@/serve/core/context'

const WAV = Buffer.from('RIFF')

function issuePaths(result: {
  success: boolean
  error?: { issues: Array<{ path: PropertyKey[] }> }
}) {
  assert.equal(result.success, false)
  return result.error!.issues.map((i) => i.path.join('/'))
}

describe('audioGenerationBody', () => {
  it('accepts a caption-only request', () => {
    assert.equal(audioGenerationBody.safeParse({ model: 'm', caption: 'lofi' }).success, true)
  })

  it('reads multipart numbers, flags and codes from their string form', () => {
    const body = audioGenerationBody.parse({
      model: 'm',
      caption: 'lofi',
      seed: '42',
      duration: '12.5',
      simpleMode: 'true',
      audioCodes: '[1, 2, 3]',
      sourceAudio: WAV
    })
    assert.equal(body.seed, 42)
    assert.equal(body.duration, 12.5)
    assert.equal(body.simpleMode, true)
    assert.deepEqual(body.audioCodes, [1, 2, 3])
  })

  it('rejects values of the wrong type', () => {
    assert.deepEqual(
      issuePaths(audioGenerationBody.safeParse({ model: 'm', caption: 'c', seed: 'x' })),
      ['seed']
    )
    assert.deepEqual(
      issuePaths(audioGenerationBody.safeParse({ model: 'm', caption: 'c', seed: 1.5 })),
      ['seed']
    )
    assert.deepEqual(
      issuePaths(audioGenerationBody.safeParse({ model: 'm', caption: 'c', taskType: 'cover' })),
      ['taskType']
    )
    assert.deepEqual(
      issuePaths(audioGenerationBody.safeParse({ model: 'm', caption: 'c', audioCodes: 'nope' })),
      ['audioCodes']
    )
  })

  it('requires a caption', () => {
    assert.deepEqual(issuePaths(audioGenerationBody.safeParse({ model: 'm' })), ['caption'])
  })

  it('rejects the SDK modelId field', () => {
    const result = audioGenerationBody.safeParse({ model: 'm', caption: 'c', modelId: 'x' })
    assert.equal(result.success, false)
  })
})

describe('audioEditBody', () => {
  const repaint = { type: 'repaint', caption: 'synth solo', start: 1, end: 2 }

  it('reads operations sent as JSON text', () => {
    const body = audioEditBody.parse({
      model: 'm',
      sourceAudio: WAV,
      operations: JSON.stringify([repaint])
    })
    assert.deepEqual(body.operations, [repaint])
  })

  it('rejects an empty or unknown operation list', () => {
    assert.deepEqual(
      issuePaths(audioEditBody.safeParse({ model: 'm', sourceAudio: WAV, operations: [] })),
      ['operations']
    )
    assert.deepEqual(
      issuePaths(
        audioEditBody.safeParse({ model: 'm', sourceAudio: WAV, operations: [{ type: 'mix' }] })
      )[0]?.split('/')[0],
      'operations'
    )
  })

  it('requires sourceAudio', () => {
    assert.deepEqual(issuePaths(audioEditBody.safeParse({ model: 'm', operations: [repaint] })), [
      'sourceAudio'
    ])
  })
})

describe('audioUnderstandingBody', () => {
  it('requires sourceAudio and accepts LM sampling fields', () => {
    assert.deepEqual(issuePaths(audioUnderstandingBody.safeParse({ model: 'm' })), ['sourceAudio'])
    const body = audioUnderstandingBody.parse({ model: 'm', sourceAudio: WAV, lmTopK: '0' })
    assert.equal(body.lmTopK, 0)
  })
})

describe('audioGenParams', () => {
  it('swaps model for modelId and audio uploads for file paths, dropping unset fields', () => {
    const body = audioGenerationBody.parse({
      model: 'alias',
      caption: 'lofi',
      sourceAudio: WAV,
      taskType: 'cover-nofsq'
    })
    assert.deepEqual(audioGenParams(body, 'sdk-id', { sourceAudio: '/tmp/a.wav' }), {
      modelId: 'sdk-id',
      caption: 'lofi',
      taskType: 'cover-nofsq',
      sourceAudio: '/tmp/a.wav'
    })
  })
})

describe('music field codes', () => {
  it('agree with every other extension', () => {
    assert.doesNotThrow(() => extensionErrorCodes([openaiExtension, defaultExtension]))
    assert.equal(MUSIC_FIELD_CODES['caption'], 'missing_caption')
  })
})

describe('createMusicJobsStore', () => {
  it('prefixes ids by kind and hides server-side fields', () => {
    const generations = createMusicJobsStore('generation')
    const edits = createMusicJobsStore('edit')
    const gen = generations.create({ model: 'm', requestId: 'r1' })
    const edit = edits.create({ model: 'm', requestId: 'r2' })
    assert.match(gen.id, /^audiogen_[0-9a-f]{24}$/)
    assert.match(edit.id, /^audioedit_[0-9a-f]{24}$/)
    assert.equal(edit.object, 'audio.edit')

    const resource = musicJobResource(gen) as unknown as Record<string, unknown>
    assert.equal(resource['object'], 'audio.generation')
    for (const field of ['requestId', 'wavFileId', 'controller']) {
      assert.equal(field in resource, false, `${field} must not reach the wire`)
    }
  })

  it('evicts the oldest job past maxEntries', () => {
    const evicted: string[] = []
    const store = createMusicJobsStore('generation', {
      maxEntries: 1,
      onEvict: (job) => evicted.push(job.id)
    })
    const first = store.create({ model: 'm', requestId: 'r1' })
    store.create({ model: 'm', requestId: 'r2' })
    assert.deepEqual(evicted, [first.id])
    assert.equal(store.get(first.id), undefined)
  })
})

describe('tearDownMusicJob', () => {
  function context(cancelled: string[], removed: string[]): QvacContext {
    return {
      logger: { debug() {} },
      files: { remove: (id: string) => removed.push(id) },
      extensions: {
        default: {
          musicJobs: {} as never,
          cancelOverride: (opts: { requestId: string }) => {
            cancelled.push(opts.requestId)
            return Promise.resolve()
          }
        }
      }
    } as unknown as QvacContext
  }

  it('aborts and cancels a running job', () => {
    const cancelled: string[] = []
    const store = createMusicJobsStore('generation')
    const job = store.create({ model: 'm', requestId: 'req-1' })
    tearDownMusicJob(context(cancelled, []), job)
    assert.equal(job.controller.signal.aborted, true)
    assert.deepEqual(cancelled, ['req-1'])
  })

  it('only drops the audio of a finished job', () => {
    const cancelled: string[] = []
    const removed: string[] = []
    const store = createMusicJobsStore('edit')
    const job = store.update(store.create({ model: 'm', requestId: 'req-2' }).id, {
      status: 'completed',
      wavFileId: 'file-1'
    })!
    tearDownMusicJob(context(cancelled, removed), job)
    assert.deepEqual(cancelled, [])
    assert.deepEqual(removed, ['file-1'])
  })
})

describe('buildWavHeader', () => {
  it('describes interleaved stereo PCM', () => {
    const header = buildWavHeader(1920, 48000, 2, 16)
    assert.equal(header.readUInt16LE(22), 2)
    assert.equal(header.readUInt32LE(24), 48000)
    assert.equal(header.readUInt32LE(28), 48000 * 4)
    assert.equal(header.readUInt16LE(32), 4)
    assert.equal(header.readUInt32LE(40), 1920)
  })

  it('defaults to mono 16-bit', () => {
    const header = buildWavHeader(10, 24000)
    assert.equal(header.readUInt16LE(22), 1)
    assert.equal(header.readUInt32LE(28), 48000)
  })
})
