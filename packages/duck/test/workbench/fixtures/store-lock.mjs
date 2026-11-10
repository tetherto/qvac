// Runs under Bare: `hold <dir>` keeps the store's lock until killed; `check <dir>` prints storeInUse.
import fs from 'bare-fs'
import path from 'bare-path'
import fsx from 'fs-native-extensions'
import { storeInUse } from '../../../dist/lib/runtime/store-lock.js'

const [mode, dir] = Bare.argv.slice(2)
if (mode === 'hold') {
  const fd = fs.openSync(path.join(dir, 'CORESTORE'), 'r+')
  fsx.tryLock(fd)
  console.log('locked')
  setInterval(() => {}, 1000)
} else {
  console.log(String(storeInUse(dir)))
}
