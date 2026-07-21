import process from 'bare-process'

export default async function start() {
  process.stdout.write('sync-sidecar-stdout\n')
  process.stderr.write('sync-sidecar-stderr\n')
  throw new Error('deliberate startup failure')
}
