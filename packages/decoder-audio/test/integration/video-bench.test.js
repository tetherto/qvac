'use strict'

// TEMPORARY research benchmark (QVAC-23856): evaluates bare-ffmpeg video
// decode + VLM-style frame sampling on real phone-camera formats, downloading
// small sample clips (~88 MB total) directly from the internet on-device.
// Emits one machine-parseable "[VBENCH] {...}" line per clip.
// Runs on mobile as runVideoBenchTest (see test/mobile/integration.auto.cjs).

const test = require('brittle')
const {
  CLIPS,
  downloadClip,
  benchBuffer,
  platformLabel
} = require('../helpers/video-bench-core')

test('video decode benchmark - real phone formats', { timeout: 1200000 }, async (t) => {
  console.log(`[VBENCH-START] platform=${platformLabel()} clips=${CLIPS.length}`)

  const results = []
  let downloadedCount = 0

  for (const clip of CLIPS) {
    let payload = null
    try {
      payload = await downloadClip(clip)
      downloadedCount++
      console.log(
        `[VBENCH-DL] ${clip.name} ok: ${(payload.buf.length / 1048576).toFixed(1)} MB in ${payload.downloadMs} ms (${clip.kind})`
      )
    } catch (err) {
      console.log(`[VBENCH-DL] ${clip.name} FAILED after retries: ${err.message}`)
      results.push({ file: clip.name, ok: false, error: 'download: ' + err.message })
      continue
    }
    const r = benchBuffer(clip.name, payload.buf)
    r.downloadMs = payload.downloadMs
    r.kind = clip.kind
    results.push(r)
  }

  // Extra pass: keyframe-only decode on the Dolby Vision clip (the production
  // fast path for sparse sampling of heavy 10-bit streams).
  const dv = CLIPS[0]
  const dvResult = results.find((r) => r.file === dv.name && r.ok)
  if (dvResult) {
    try {
      const payload = await downloadClip(dv)
      benchBuffer(dv.name + ' [nokey]', payload.buf, { skipFrame: 'nokey' })
    } catch (err) {
      console.log(`[VBENCH] nokey pass skipped: ${err.message}`)
    }
  }

  // Tolerate at most one CDN hiccup, but every downloaded clip must decode.
  t.ok(downloadedCount >= CLIPS.length - 1, `downloaded ${downloadedCount}/${CLIPS.length} clips`)
  for (const r of results) {
    if (r.error && r.error.startsWith('download:')) continue
    t.ok(r.ok, `${r.file} decoded (${r.framesDecoded ?? 0} frames, ${r.decodeFps ?? 0} fps)`)
  }

  if (dvResult) {
    t.ok(dvResult.is10bit, 'Dolby Vision clip decoded as 10-bit')
    t.is(dvResult.hdr, 'HLG', 'Dolby Vision 8.4 signals HLG transfer')
    t.ok(dvResult.framesSampled > 0, 'sampled RGB24 frames from 10-bit source')
  }

  const rot = results.find((r) => r.file === 'bear_rotate_90.mp4' && r.ok)
  if (rot) {
    t.ok(
      (rot.sideData || []).some((s) => /display matrix/i.test(s)),
      'rotation metadata surfaced as Display Matrix side data'
    )
  }

  console.log('[VBENCH-END] ' + JSON.stringify({ platform: platformLabel(), results: results.length, downloaded: downloadedCount }))
})
