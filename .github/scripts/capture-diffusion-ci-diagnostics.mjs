import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

function fingerprint(file) {
  const digest = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let size
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, size))
    }
  } finally {
    fs.closeSync(fd)
  }
  return digest.digest('hex')
}

export function captureDiagnostics({ workdir, phase, run = spawnSync }) {
  assert(['before', 'after'].includes(phase), 'Expected before or after')
  workdir = path.resolve(workdir)
  const output = path.join(workdir, 'test/results/nvidia-diagnostics')
  fs.mkdirSync(output, { recursive: true })
  const command = (file, args) => {
    try {
      const result = run(file, args, {
        cwd: workdir,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      })
      return {
        status: result.status,
        error: result.error?.message,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
      }
    } catch (error) {
      return { status: null, error: error.message, stdout: '', stderr: '' }
    }
  }
  const host = path.join(workdir, 'prebuilds/linux-x64')
  const files = []
  function visit(dir, depth) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 2) visit(file, depth + 1)
      else if (entry.isFile() && /\.(bare|so)$/.test(entry.name)) files.push(file)
    }
  }
  visit(host, 0)
  const metadata = {
    phase,
    capturedAt: new Date().toISOString(),
    node: process.version,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    job: process.env.GITHUB_JOB,
    runner: process.env.RUNNER_NAME,
    source: command('git', ['rev-parse', 'HEAD']),
    bare: command('bare', ['--version']),
    modules: [],
    errors: []
  }
  for (const file of files) {
    try {
      metadata.modules.push({ file: path.relative(workdir, file), sha256: fingerprint(file) })
    } catch (error) {
      metadata.errors.push({ file: path.relative(workdir, file), error: error.message })
    }
  }
  const cuda = files.find((file) => path.basename(file) === 'libqvac-diffusion-ggml-cuda.so')
  const collector = fileURLToPath(new URL('./collect-cuda-runtime-info.py', import.meta.url))
  const runtime = command('python3', [collector, ...(cuda ? [cuda] : [])])
  let report
  try {
    report = JSON.parse(runtime.stdout)
  } catch {
    report = { captureError: 'Runtime collector did not return JSON', ...runtime }
  }
  fs.writeFileSync(
    path.join(output, `${phase}-runtime.json`),
    JSON.stringify(report, null, 2) + '\n'
  )
  if (runtime.stderr)
    fs.writeFileSync(path.join(output, `${phase}-collector.stderr.log`), runtime.stderr)
  metadata.runtimeCollector = { status: runtime.status, error: runtime.error }
  const testLog = path.join(workdir, 'test-output.log')
  if (phase === 'after' && fs.existsSync(testLog)) {
    fs.copyFileSync(testLog, path.join(output, 'integration-test-output.log'))
  }
  fs.writeFileSync(
    path.join(output, `${phase}-context.json`),
    JSON.stringify(metadata, null, 2) + '\n'
  )
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [workdir, phase] = process.argv.slice(2)
  assert(workdir, 'Expected a package working directory')
  console.log(`Diagnostic bundle: ${captureDiagnostics({ workdir, phase })}`)
}
