import assert from 'node:assert/strict'
import path from 'node:path'

export function originalProbe({ probe, bare, testFile, output, environment }) {
  assert(
    [
      'baseline',
      'repeat',
      'trace-repeat',
      'sync',
      'node',
      'no-graphs',
      'no-fusion',
      'memcheck',
      'initcheck',
      'mmq-initcheck',
      'nsys'
    ].includes(probe),
    'Unknown diagnostic probe'
  )
  const env = { ...environment }
  env.PATH = `/usr/local/cuda/bin:${env.PATH || ''}`
  let command = bare
  let args = [testFile, '--exit']
  if (probe === 'memcheck' || probe === 'initcheck') {
    command = 'compute-sanitizer'
    // Models may be downloaded before the first CUDA API call. Keep the outer
    // process timeout, but do not abandon instrumentation during provisioning.
    args = [
      '--tool',
      probe,
      '--launch-timeout',
      '0',
      '--kill',
      '--error-exitcode',
      '86',
      bare,
      ...args
    ]
  } else if (probe === 'nsys') {
    command = 'nsys'
    args = [
      'profile',
      '--trace=cuda,nvtx',
      '--sample=none',
      '--output',
      path.join(output, 'original-addon-trace'),
      bare,
      ...args
    ]
  } else if (probe === 'no-graphs') env.GGML_CUDA_DISABLE_GRAPHS = '1'
  else if (probe === 'no-fusion') env.GGML_CUDA_DISABLE_FUSION = '1'
  // Sync/node/MMQ instrumentation lives in the rebuilt native executable only.
  return { command, args, env }
}

export function sanitizerCompleted(probe, log) {
  if (probe !== 'memcheck' && probe !== 'initcheck') return true
  return (
    /ERROR SUMMARY: 0 errors/.test(log) &&
    !/========= (Error:|Internal Sanitizer Error)/.test(log)
  )
}
