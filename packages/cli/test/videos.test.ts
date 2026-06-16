import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  videosCreateBody,
  extractVideoCreateParams,
  nearestVideoFrameCount,
  InvalidVideoStrengthError,
  DEFAULT_FPS
} from '../src/serve/schemas/videos.js'
import { createVideoJobsStore, type VideoJob } from '../src/serve/core/video-jobs-store.js'
import { tearDownJob, resolveInputReferenceImage } from '../src/serve/routes/videos.js'
import type { QvacContext } from '../src/serve/lib/types.js'

function expectIssue (input: unknown, path: string): { message: string } {
  const result = videosCreateBody.safeParse(input)
  assert.equal(result.success, false, `expected validation to fail for ${JSON.stringify(input)}`)
  const issue = result.error!.issues.find((i) => i.path.join('/') === path)
  assert.ok(issue, `expected an issue at path "${path}"; got ${JSON.stringify(result.error!.issues)}`)
  return { message: issue.message }
}

describe('videosCreateBody (Zod validation)', () => {
  it('requires non-empty prompt', () => {
    expectIssue({}, 'prompt')
    expectIssue({ prompt: '' }, 'prompt')
  })

  it('caps prompt at 32000 chars', () => {
    expectIssue({ prompt: 'a'.repeat(32001) }, 'prompt')
  })

  describe('size', () => {
    it('accepts WxH multiples of 16', () => {
      assert.equal(videosCreateBody.safeParse({ prompt: 'p', size: '480x832' }).success, true)
      assert.equal(videosCreateBody.safeParse({ prompt: 'p', size: '720x1280' }).success, true)
    })

    it('rejects non-multiples of 16', () => {
      expectIssue({ prompt: 'p', size: '481x832' }, 'size')
      expectIssue({ prompt: 'p', size: '480x833' }, 'size')
      expectIssue({ prompt: 'p', size: '488x832' }, 'size')
    })

    it('rejects malformed', () => {
      expectIssue({ prompt: 'p', size: '480' }, 'size')
      expectIssue({ prompt: 'p', size: 'big' }, 'size')
      expectIssue({ prompt: 'p', size: '480X832' }, 'size')
    })

    it('rejects zero/negative dims', () => {
      expectIssue({ prompt: 'p', size: '0x832' }, 'size')
    })
  })

  describe('seconds', () => {
    it('accepts positive integer strings', () => {
      for (const s of ['4', '8', '12', '2', '30']) {
        assert.equal(videosCreateBody.safeParse({ prompt: 'p', seconds: s }).success, true)
      }
    })

    it('rejects fractional / negative', () => {
      expectIssue({ prompt: 'p', seconds: '2.5' }, 'seconds')
      expectIssue({ prompt: 'p', seconds: '-4' }, 'seconds')
    })
  })

  describe('fps', () => {
    it('accepts numbers in (0, 120]', () => {
      assert.equal(videosCreateBody.safeParse({ prompt: 'p', fps: 16 }).success, true)
      assert.equal(videosCreateBody.safeParse({ prompt: 'p', fps: 120 }).success, true)
    })

    it('rejects out-of-range', () => {
      expectIssue({ prompt: 'p', fps: 0 }, 'fps')
      expectIssue({ prompt: 'p', fps: 121 }, 'fps')
    })
  })

  it('accepts input_reference with image_url as a flat string', () => {
    assert.equal(videosCreateBody.safeParse({
      prompt: 'p',
      input_reference: { image_url: 'data:image/jpeg;base64,/9j/' }
    }).success, true)
  })

  it('accepts input_reference with file_id', () => {
    assert.equal(videosCreateBody.safeParse({
      prompt: 'p',
      input_reference: { file_id: 'file-abc123' }
    }).success, true)
  })

  it('rejects input_reference with neither image_url nor file_id', () => {
    expectIssue({ prompt: 'p', input_reference: { not_image_url: 'x' } }, 'input_reference')
  })

  it('accepts strength as a number', () => {
    assert.equal(videosCreateBody.safeParse({ prompt: 'p', strength: 0.85 }).success, true)
    assert.equal(videosCreateBody.safeParse({ prompt: 'p', strength: 0 }).success, true)
    assert.equal(videosCreateBody.safeParse({ prompt: 'p', strength: 1 }).success, true)
  })

  it('accepts strength as a number or numeric string', () => {
    assert.equal(videosCreateBody.safeParse({ prompt: 'p', strength: '0.85' }).success, true)
  })

  it('accepts input_reference as a Buffer (multipart file)', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    assert.equal(videosCreateBody.safeParse({ prompt: 'p', input_reference: buf }).success, true)
  })
})

describe('nearestVideoFrameCount', () => {
  it('rounds to the nearest integer of form 4k+1 with k>=1', () => {
    assert.equal(nearestVideoFrameCount(64), 65)
    assert.equal(nearestVideoFrameCount(65), 65)
    assert.equal(nearestVideoFrameCount(66), 65)
    assert.equal(nearestVideoFrameCount(67), 69)
    assert.equal(nearestVideoFrameCount(128), 129)
    assert.equal(nearestVideoFrameCount(1), 5)
    assert.equal(nearestVideoFrameCount(0), 5)
  })

  it('handles non-finite gracefully', () => {
    assert.equal(nearestVideoFrameCount(NaN), 5)
    assert.equal(nearestVideoFrameCount(Infinity), 5)
  })
})

describe('extractVideoCreateParams', () => {
  it('returns mode=txt2vid when no initImage', () => {
    const params = extractVideoCreateParams({ prompt: 'a cat surfing' }, undefined, 'sdk-vid-1')
    assert.equal(params.modelId, 'sdk-vid-1')
    assert.equal(params.mode, 'txt2vid')
    assert.equal(params.prompt, 'a cat surfing')
    assert.equal(params.width, undefined)
    assert.equal(params.height, undefined)
    assert.equal(params.video_frames, undefined)
    assert.equal(params.fps, undefined)
  })

  it('translates size → width/height', () => {
    const params = extractVideoCreateParams({ prompt: 'p', size: '480x832' }, undefined, 'm')
    assert.equal(params.width, 480)
    assert.equal(params.height, 832)
  })

  it('translates seconds → video_frames using default fps', () => {
    const params = extractVideoCreateParams({ prompt: 'p', seconds: '4' }, undefined, 'm')
    assert.equal(params.video_frames, 4 * DEFAULT_FPS + 1)
  })

  it('translates seconds → video_frames using explicit fps', () => {
    const params = extractVideoCreateParams({ prompt: 'p', seconds: '2', fps: 24 }, undefined, 'm')
    assert.equal(params.fps, 24)
    assert.equal(params.video_frames, 49)
  })

  it('passes through seed and steps when present', () => {
    const params = extractVideoCreateParams({ prompt: 'p', seed: 42, steps: 1 }, undefined, 'm')
    assert.equal(params.seed, 42)
    assert.equal(params.steps, 1)
  })

  describe('img2vid mode', () => {
    const initImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

    it('returns mode=img2vid with init_image when initImage is provided', () => {
      const params = extractVideoCreateParams({ prompt: 'turns and smiles' }, initImage, 'm')
      assert.equal(params.mode, 'img2vid')
      assert.equal((params as Record<string, unknown>).init_image, initImage)
      assert.equal(params.prompt, 'turns and smiles')
    })

    it('includes coerced strength when provided as number', () => {
      const params = extractVideoCreateParams({ prompt: 'p', strength: 0.85 }, initImage, 'm')
      assert.equal((params as Record<string, unknown>).strength, 0.85)
    })

    it('coerces strength from string to float', () => {
      const params = extractVideoCreateParams({ prompt: 'p', strength: '0.5' }, initImage, 'm')
      assert.equal((params as Record<string, unknown>).strength, 0.5)
    })

    it('omits strength when not provided', () => {
      const params = extractVideoCreateParams({ prompt: 'p' }, initImage, 'm')
      assert.equal('strength' in params, false)
    })

    it('throws InvalidVideoStrengthError for out-of-range strength', () => {
      assert.throws(
        () => extractVideoCreateParams({ prompt: 'p', strength: 1.5 }, initImage, 'm'),
        InvalidVideoStrengthError
      )
      assert.throws(
        () => extractVideoCreateParams({ prompt: 'p', strength: -0.1 }, initImage, 'm'),
        InvalidVideoStrengthError
      )
    })

    it('throws InvalidVideoStrengthError for non-numeric strength string', () => {
      assert.throws(
        () => extractVideoCreateParams({ prompt: 'p', strength: 'high' }, initImage, 'm'),
        InvalidVideoStrengthError
      )
    })
  })
})

describe('createVideoJobsStore', () => {
  it('creates jobs with unique ids and queued state', () => {
    const store = createVideoJobsStore()
    const a = store.create({ model: 'wan', prompt: 'p1', size: '480x832', seconds: '4' })
    const b = store.create({ model: 'wan', prompt: 'p2', size: '480x832', seconds: '4' })
    assert.notEqual(a.id, b.id)
    assert.ok(a.id.startsWith('video_'))
    assert.equal(a.status, 'queued')
    assert.equal(a.progress, 0)
    assert.equal(a.error, null)
    assert.equal(a.aviFileId, null)
    assert.equal(a.completed_at, null)
    assert.equal(a.object, 'video')
    assert.equal(a.remixed_from_video_id, null)
  })

  it('update mutates the same record and returns it', () => {
    const store = createVideoJobsStore()
    const job = store.create({ model: 'wan', prompt: 'p', size: '480x832', seconds: '4' })
    const updated = store.update(job.id, { status: 'in_progress', progress: 50 })
    assert.equal(updated?.status, 'in_progress')
    assert.equal(updated?.progress, 50)
    assert.equal(store.get(job.id)?.progress, 50)
  })

  it('delete removes the job', () => {
    const store = createVideoJobsStore()
    const job = store.create({ model: 'wan', prompt: 'p', size: '480x832', seconds: '4' })
    assert.equal(store.delete(job.id), true)
    assert.equal(store.get(job.id), undefined)
  })

  it('list returns jobs newest-first by default, with cursor pagination', () => {
    let t = 1_000
    const store = createVideoJobsStore({ now: () => t * 1000 })
    const a = store.create({ model: 'wan', prompt: 'a', size: '480x832', seconds: '4' })
    t += 1
    const b = store.create({ model: 'wan', prompt: 'b', size: '480x832', seconds: '4' })
    t += 1
    const c = store.create({ model: 'wan', prompt: 'c', size: '480x832', seconds: '4' })

    const page1 = store.list({ limit: 2 })
    assert.deepEqual(page1.data.map((j) => j.id), [c.id, b.id])
    assert.equal(page1.first_id, c.id)
    assert.equal(page1.last_id, b.id)
    assert.equal(page1.has_more, true)

    const page2 = store.list({ limit: 2, after: b.id })
    assert.deepEqual(page2.data.map((j) => j.id), [a.id])
    assert.equal(page2.has_more, false)
  })

  it('list respects asc order', () => {
    const store = createVideoJobsStore()
    const a = store.create({ model: 'wan', prompt: 'a', size: '480x832', seconds: '4' })
    const b = store.create({ model: 'wan', prompt: 'b', size: '480x832', seconds: '4' })
    const page = store.list({ order: 'asc' })
    assert.deepEqual(page.data.map((j) => j.id), [a.id, b.id])
  })

  it('evicts oldest job when maxEntries exceeded', () => {
    const store = createVideoJobsStore({ maxEntries: 2 })
    const a = store.create({ model: 'wan', prompt: 'a', size: '480x832', seconds: '4' })
    const b = store.create({ model: 'wan', prompt: 'b', size: '480x832', seconds: '4' })
    const c = store.create({ model: 'wan', prompt: 'c', size: '480x832', seconds: '4' })
    assert.equal(store.get(a.id), undefined)
    assert.ok(store.get(b.id))
    assert.ok(store.get(c.id))
  })

  it('invokes onEvict with the dropped job and reason', () => {
    const evicted: Array<{ id: string; reason: string }> = []
    const store = createVideoJobsStore({
      maxEntries: 1,
      onEvict: (job, reason) => evicted.push({ id: job.id, reason })
    })
    const a = store.create({ model: 'wan', prompt: 'a', size: '480x832', seconds: '4' })
    const b = store.create({ model: 'wan', prompt: 'b', size: '480x832', seconds: '4' })
    assert.deepEqual(evicted, [{ id: a.id, reason: 'max_entries' }])
    assert.equal(store.get(a.id), undefined)
    assert.ok(store.get(b.id))
  })

})

// ─── tearDownJob ───────────────────────────────────────────────────────

function makeCtxStub (opts: {
  cancelOverride?: QvacContext['cancelOverride']
  removed?: string[]
  files?: Record<string, { data: Buffer } | undefined>
} = {}): QvacContext {
  const removed = opts.removed ?? []
  const files = opts.files ?? {}
  const stub = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ephemeralFiles: {
      remove: (id: string) => { removed.push(id) },
      get: (id: string) => files[id]
    }
  } as unknown as QvacContext
  if (opts.cancelOverride) {
    (stub as { cancelOverride?: QvacContext['cancelOverride'] }).cancelOverride = opts.cancelOverride
  }
  return stub
}

// Temporarily replaces globalThis.fetch for a single async test body; always restores.
async function withMockFetch<T> (mock: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function makeJob (overrides: Partial<VideoJob> = {}): VideoJob {
  const base: VideoJob = {
    id: 'video_test',
    object: 'video',
    model: 'wan',
    status: 'in_progress',
    progress: 50,
    created_at: 0,
    completed_at: null,
    expires_at: 253402300799,
    prompt: 'p',
    size: '480x832',
    seconds: '4',
    remixed_from_video_id: null,
    error: null,
    requestId: 'req-xyz',
    aviFileId: null,
    mp4FileId: null,
    controller: new AbortController()
  }
  return { ...base, ...overrides }
}

describe('resolveInputReferenceImage', () => {
  // ── data URI ─────────────────────────────────────────────────────────

  it('rejects data URI missing the comma separator', async () => {
    const ctx = makeCtxStub()
    await assert.rejects(
      () => resolveInputReferenceImage({ image_url: 'data:image/jpeg;base64' }, ctx),
      (err: unknown) => err instanceof Error && err.message.includes('comma separator')
    )
  })

  it('rejects data URI with non-base64 encoding header', async () => {
    const ctx = makeCtxStub()
    await assert.rejects(
      () => resolveInputReferenceImage({ image_url: 'data:image/jpeg;utf8,hello' }, ctx),
      (err: unknown) => err instanceof Error && err.message.includes('base64-encoded')
    )
  })

  it('rejects data URI with invalid base64 characters', async () => {
    const ctx = makeCtxStub()
    await assert.rejects(
      () => resolveInputReferenceImage({ image_url: 'data:image/jpeg;base64,!!!invalid!!!' }, ctx),
      (err: unknown) => err instanceof Error && err.message.includes('invalid base64 characters')
    )
  })

  it('rejects data URI that decodes to empty bytes', async () => {
    const ctx = makeCtxStub()
    await assert.rejects(
      () => resolveInputReferenceImage({ image_url: 'data:image/jpeg;base64,' }, ctx),
      (err: unknown) => err instanceof Error && err.message.includes('empty bytes')
    )
  })

  it('returns decoded bytes for a valid data URI', async () => {
    const ctx = makeCtxStub()
    // "AQID" is base64 for [0x01, 0x02, 0x03]
    const result = await resolveInputReferenceImage({ image_url: 'data:image/png;base64,AQID' }, ctx)
    assert.deepEqual(result, new Uint8Array([0x01, 0x02, 0x03]))
  })

  // ── unknown scheme ───────────────────────────────────────────────────

  it('rejects an unknown URL scheme', async () => {
    const ctx = makeCtxStub()
    await assert.rejects(
      () => resolveInputReferenceImage({ image_url: 'ftp://example.com/img.png' }, ctx),
      (err: unknown) => err instanceof Error && err.message.includes('base64 data URI or an HTTP(S) URL')
    )
  })

  // ── file_id ──────────────────────────────────────────────────────────

  it('rejects an unknown file_id', async () => {
    const ctx = makeCtxStub({ files: {} })
    await assert.rejects(
      () => resolveInputReferenceImage({ file_id: 'file-missing' }, ctx),
      (err: unknown) => err instanceof Error && err.message.includes('not found')
    )
  })

  it('returns bytes for a known file_id', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const ctx = makeCtxStub({ files: { 'file-abc': { data } } })
    const result = await resolveInputReferenceImage({ file_id: 'file-abc' }, ctx)
    assert.deepEqual(result, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  // ── HTTP fetch ───────────────────────────────────────────────────────

  it('rejects HTTP URL that returns a non-200 response', async () => {
    const ctx = makeCtxStub()
    await withMockFetch(
      async () => ({ ok: false, status: 404 } as Response),
      async () => {
        await assert.rejects(
          () => resolveInputReferenceImage({ image_url: 'https://example.com/img.png' }, ctx),
          (err: unknown) => err instanceof Error && err.message.includes('HTTP 404')
        )
      }
    )
  })

  it('rejects HTTP URL when fetch throws a network error', async () => {
    const ctx = makeCtxStub()
    await withMockFetch(
      async () => { throw new Error('ECONNREFUSED') },
      async () => {
        await assert.rejects(
          () => resolveInputReferenceImage({ image_url: 'https://example.com/img.png' }, ctx),
          (err: unknown) => err instanceof Error && err.message.includes('ECONNREFUSED')
        )
      }
    )
  })

  it('rejects HTTP URL when fetch times out on initial connect', async () => {
    const ctx = makeCtxStub()
    const timeoutErr = Object.assign(new Error('fetch timed out'), { name: 'TimeoutError' })
    await withMockFetch(
      async () => { throw timeoutErr },
      async () => {
        await assert.rejects(
          () => resolveInputReferenceImage({ image_url: 'https://example.com/img.png' }, ctx),
          (err: unknown) => err instanceof Error && err.message.includes('timed out after')
        )
      }
    )
  })

  it('rejects HTTP URL when response body exceeds the 100 MB limit', async () => {
    const ctx = makeCtxStub()
    const bigChunk = new Uint8Array(101 * 1024 * 1024)
    await withMockFetch(
      async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: bigChunk }),
            cancel: async () => {},
            releaseLock: () => {}
          })
        }
      } as unknown as Response),
      async () => {
        await assert.rejects(
          () => resolveInputReferenceImage({ image_url: 'https://example.com/big.png' }, ctx),
          (err: unknown) => err instanceof Error && err.message.includes('exceeds')
        )
      }
    )
  })

  it('rejects HTTP URL when body read throws an error', async () => {
    const ctx = makeCtxStub()
    await withMockFetch(
      async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => { throw new Error('stream error') },
            cancel: async () => {},
            releaseLock: () => {}
          })
        }
      } as unknown as Response),
      async () => {
        await assert.rejects(
          () => resolveInputReferenceImage({ image_url: 'https://example.com/img.png' }, ctx),
          (err: unknown) => err instanceof Error && err.message.includes('failed reading response body')
        )
      }
    )
  })
})

describe('tearDownJob', () => {
  it('aborts the controller and cancels the SDK request for in-progress jobs', () => {
    const cancelled: Array<{ requestId: string }> = []
    const ctx = makeCtxStub({
      cancelOverride: async (opts) => { cancelled.push(opts); return undefined as never }
    })
    const job = makeJob({ status: 'in_progress', requestId: 'req-abc' })
    tearDownJob(ctx, job)
    assert.equal(job.controller.signal.aborted, true)
    assert.deepEqual(cancelled, [{ requestId: 'req-abc' }])
  })

  it('skips cancel for completed jobs', () => {
    const cancelled: Array<{ requestId: string }> = []
    const ctx = makeCtxStub({
      cancelOverride: async (opts) => { cancelled.push(opts); return undefined as never }
    })
    const job = makeJob({ status: 'completed', requestId: 'req-abc', aviFileId: 'file-1' })
    tearDownJob(ctx, job)
    assert.deepEqual(cancelled, [])
    assert.equal(job.controller.signal.aborted, false)
  })

  it('skips cancel when requestId is not yet set', () => {
    const cancelled: Array<{ requestId: string }> = []
    const ctx = makeCtxStub({
      cancelOverride: async (opts) => { cancelled.push(opts); return undefined as never }
    })
    const job = makeJob({ status: 'queued', requestId: null })
    tearDownJob(ctx, job)
    assert.equal(job.controller.signal.aborted, true)
    assert.deepEqual(cancelled, [])
  })

  it('removes both ephemeral file ids when present', () => {
    const removed: string[] = []
    const ctx = makeCtxStub({ removed })
    const job = makeJob({ status: 'completed', aviFileId: 'avi-1', mp4FileId: 'mp4-1' })
    tearDownJob(ctx, job)
    assert.deepEqual(removed.sort(), ['avi-1', 'mp4-1'])
  })

  it('survives a rejecting cancelFn (no throw)', () => {
    const ctx = makeCtxStub({
      cancelOverride: async () => { throw new Error('worker down') }
    })
    const job = makeJob({ status: 'in_progress', requestId: 'req-abc' })
    assert.doesNotThrow(() => tearDownJob(ctx, job))
  })
})
