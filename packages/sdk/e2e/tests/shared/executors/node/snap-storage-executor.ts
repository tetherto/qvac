import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { heartbeat } from '@qvac/sdk'
import { BaseExecutor, type TestResult } from '@tetherto/qvac-test-suite'
import { snapStorageTests } from '../../../snap-storage-tests.js'

export class SnapStorageExecutor extends BaseExecutor<typeof snapStorageTests> {
  pattern = /^snap-storage-/

  protected handlers = {
    'snap-storage-common-root': this.verifyCommonRoot.bind(this)
  }

  private async verifyCommonRoot(): Promise<TestResult> {
    const snapCommon = process.env['SNAP_USER_COMMON']
    const snapUserData = process.env['SNAP_USER_DATA']
    const home = process.env['HOME']
    const revision = process.env['SNAP_REVISION']

    if (!snapCommon || !snapUserData || !home || !revision) {
      return {
        passed: false,
        output:
          'Expected SNAP_USER_COMMON, SNAP_USER_DATA, HOME, and SNAP_REVISION inside the Snap runtime'
      }
    }

    if (home !== snapUserData) {
      return {
        passed: false,
        output: `Expected HOME to equal SNAP_USER_DATA; HOME=${home}, SNAP_USER_DATA=${snapUserData}`
      }
    }

    if (snapCommon === home) {
      return {
        passed: false,
        output: `Expected common storage to differ from revision HOME: ${home}`
      }
    }

    await heartbeat()

    const commonLock = join(snapCommon, '.qvac', '.worker.lock')
    const revisionQvacDir = join(home, '.qvac')
    if (!existsSync(commonLock)) {
      return {
        passed: false,
        output: `SDK worker lock was not created in Snap common storage: ${commonLock}`
      }
    }
    if (existsSync(revisionQvacDir)) {
      return {
        passed: false,
        output: `SDK unexpectedly created revision-scoped storage: ${revisionQvacDir}`
      }
    }

    return {
      passed: true,
      output: JSON.stringify({
        home,
        revision,
        snapCommon,
        workerLock: commonLock
      })
    }
  }
}
