#!/usr/bin/env npx tsx
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureOpenAiApiCoverage } from './coverage'
import { atomicWriteJson } from './persistence'
import { writeOpenAiCoveragePreview } from './report'
import type { OpenAiApiCoverageSnapshot } from './types'

type CoverageCapture = () => Promise<OpenAiApiCoverageSnapshot>

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url))

export function outputDirectory(argv: string[]) {
  const index = argv.indexOf('--out-dir')
  if (index === -1) {
    return join(BENCHMARK_DIR, 'results', 'coverage-preview')
  }
  const value = argv[index + 1]
  if (!value) {
    throw new Error('--out-dir requires a path')
  }
  return resolve(value)
}

export async function generateOpenAiCoveragePreview(
  outputDir: string,
  capture: CoverageCapture = captureOpenAiApiCoverage
) {
  mkdirSync(outputDir, { recursive: true })
  const snapshot = await capture()
  atomicWriteJson(join(outputDir, 'coverage.json'), snapshot)
  writeOpenAiCoveragePreview(snapshot, join(outputDir, 'report.md'))
  return snapshot
}

export async function main(argv: string[]) {
  const outputDir = outputDirectory(argv)
  const snapshot = await generateOpenAiCoveragePreview(outputDir)
  if (snapshot.status === 'unavailable') {
    console.error(`OpenAI API coverage unavailable: ${snapshot.errors.join('; ')}`)
    return 1
  }
  console.log(`Coverage preview written to ${outputDir}`)
  return 0
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
}
