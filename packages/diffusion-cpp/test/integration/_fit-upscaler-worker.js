'use strict'

// Launched with fixed planner budgets in its initial environment. Keep this
// outside the *.test.js suite: the parent test owns the assertions.
const fs = require('bare-fs')
const proc = require('bare-process')
const { assessFit } = require('../../index.js')

async function main() {
  const files = JSON.parse(proc.argv[2])
  const results = []
  for (const videoFrames of [1, 5]) {
    const request = {
      files,
      workload: { width: 256, height: 256, videoFrames, vaeTiling: true }
    }
    const base = await assessFit(request)
    const unused = await assessFit({
      ...request,
      files: { ...files, esrgan: '/missing/unused-esrgan.safetensors' }
    })
    results.push({ videoFrames, base, unused })
  }
  fs.writeFileSync(proc.argv[3], JSON.stringify(results))
}

main().catch((error) => {
  console.error(error)
  proc.exitCode = 1
})
