'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const { clips } = require('./video-config.cjs')
const { extract, hashFile } = require('./video-core.cjs')
const [directory, outputDirectory, only] = Bare.argv.slice(2)
fs.mkdirSync(outputDirectory, { recursive: true })
const rows = []
for (const clip of clips) {
  if (only && clip.id !== only) continue
  const file = path.join(directory, clip.file)
  const sha256 = hashFile(file)
  for (const mode of ['full', 'key']) {
    const { frames, record } = extract(file, mode, { limitSeconds: clip.limitSeconds })
    const prefix = path.join(outputDirectory, clip.id + '-' + mode)
    fs.mkdirSync(prefix, { recursive: true })
    record.paths = frames.map((frame, i) => {
      const out = path.join(prefix, i + '.ppm')
      fs.writeFileSync(out, frame.ppm)
      return out
    })
    Object.assign(record, { clip: clip.id, sha256, url: clip.url })
    rows.push(record)
    console.log('[VIDEO-EXTRACT] ' + JSON.stringify(record))
  }
}
fs.writeFileSync(
  path.join(outputDirectory, 'extraction' + (only ? '-' + only : '') + '.json'),
  JSON.stringify(rows, null, 2)
)
