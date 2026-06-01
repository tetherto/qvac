import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  videosCreateBody,
  extractVideoCreateParams,
  nearestVideoFrameCount,
  DEFAULT_FPS
} from '../src/serve/schemas/videos.js'
import { createVideoJobsStore } from '../src/serve/core/video-jobs-store.js'

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
    it('accepts WxH multiples of 8', () => {
      assert.equal(videosCreateBody.safeParse({ prompt: 'p', size: '480x832' }).success, true)
      assert.equal(videosCreateBody.safeParse({ prompt: 'p', size: '720x1280' }).success, true)
    })

    it('rejects non-multiples of 8', () => {
      expectIssue({ prompt: 'p', size: '481x832' }, 'size')
      expectIssue({ prompt: 'p', size: '480x833' }, 'size')
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

  it('rejects input_reference (img2vid not supported)', () => {
    const result = expectIssue({ prompt: 'p', input_reference: { image_url: 'x' } }, 'input_reference')
    assert.match(result.message, /image-to-video|not supported/i)
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
  it('returns mode=txt2vid and the modelId', () => {
    const params = extractVideoCreateParams({ prompt: 'a cat surfing' }, 'sdk-vid-1')
    assert.equal(params.modelId, 'sdk-vid-1')
    assert.equal(params.mode, 'txt2vid')
    assert.equal(params.prompt, 'a cat surfing')
    assert.equal(params.width, undefined)
    assert.equal(params.height, undefined)
    assert.equal(params.video_frames, undefined)
    assert.equal(params.fps, undefined)
  })

  it('translates size → width/height', () => {
    const params = extractVideoCreateParams({ prompt: 'p', size: '480x832' }, 'm')
    assert.equal(params.width, 480)
    assert.equal(params.height, 832)
  })

  it('translates seconds → video_frames using default fps', () => {
    const params = extractVideoCreateParams({ prompt: 'p', seconds: '4' }, 'm')
    assert.equal(params.video_frames, 4 * DEFAULT_FPS + 1)
  })

  it('translates seconds → video_frames using explicit fps', () => {
    const params = extractVideoCreateParams({ prompt: 'p', seconds: '2', fps: 24 }, 'm')
    assert.equal(params.fps, 24)
    assert.equal(params.video_frames, 49)
  })

  it('passes through seed and steps when present', () => {
    const params = extractVideoCreateParams({ prompt: 'p', seed: 42, steps: 1 }, 'm')
    assert.equal(params.seed, 42)
    assert.equal(params.steps, 1)
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

})
