import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { compiledModule } from '../helpers/package-under-test.mjs'
const { bootCore } = await import(compiledModule('lib/runtime/core-host.js').href)
import { decodeMeshInvite, encodeMeshInvite } from '@qvac/core/invite'
const { qrLines } = await import(compiledModule('product/qr.js').href)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-invite-smoke-'))
const host = await bootCore({
  dataDir,
  fakeModels: true,
  noDefaultModels: true
})
let exitCode = 0
try {
  const { invite } = await host.engine.meshInvite({})
  const decoded = decodeMeshInvite(invite),
    compact = encodeMeshInvite({ ...decoded, fastForward: null })
  console.log(
    JSON.stringify({
      original: invite.length,
      compact: compact.length,
      rows: qrLines(compact).length,
      valid: !!decodeMeshInvite(compact)
    })
  )
} catch (error) {
  console.error(error.stack || error)
  exitCode = 1
} finally {
  await host.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  Bare.exit(exitCode)
}
