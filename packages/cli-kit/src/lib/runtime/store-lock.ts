import fs from 'bare-fs'
import path from 'bare-path'
import fsx from 'fs-native-extensions'

// Core locks this file only once it is far into boot, so a second Core would open the store first.
export function storeInUse(storageDir: string) {
  let fd
  try {
    fd = fs.openSync(path.join(storageDir, 'CORESTORE'), 'r+')
  } catch {
    return false // no store yet, so nothing can hold it
  }

  try {
    if (!fsx.tryLock(fd)) {
      return true
    }

    fsx.unlock(fd)

    return false
  } finally {
    fs.closeSync(fd)
  }
}
