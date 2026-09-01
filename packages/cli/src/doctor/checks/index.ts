import type { CheckContext } from '@/doctor/check'
import { createDefaultContext } from '@/doctor/check'
import type { CheckSection } from '@/doctor/types'
import { checkNodeVersion, checkCliHost } from '@/doctor/checks/runtime'
import {
  checkTotalMemory,
  checkAvailableMemory,
  checkGpuAcceleration,
  checkFreeDiskSpace
} from '@/doctor/checks/hardware'
import { checkDesktopTargets, checkAndroidTarget, checkIosTarget } from '@/doctor/checks/targets'
import { checkFfmpeg, checkBareRuntime, checkBun } from '@/doctor/checks/tools'
import { checkSdkInstalled } from '@/doctor/checks/project'

export type { Check, CheckContext, ProbeFn, ProbeResult } from '@/doctor/check'
export { createDefaultContext, probeBinary } from '@/doctor/check'
export { checkNodeVersion, checkCliHost } from '@/doctor/checks/runtime'
export {
  checkTotalMemory,
  checkAvailableMemory,
  checkGpuAcceleration,
  checkFreeDiskSpace
} from '@/doctor/checks/hardware'
export { checkDesktopTargets, checkAndroidTarget, checkIosTarget } from '@/doctor/checks/targets'
export { checkFfmpeg, checkBareRuntime, checkBun } from '@/doctor/checks/tools'
export { checkSdkInstalled } from '@/doctor/checks/project'

export interface CollectChecksOptions {
  context?: CheckContext | undefined
  projectRoot?: string | undefined
}

export function collectCheckSections(options: CollectChecksOptions = {}): CheckSection[] {
  const ctx = options.context ?? createDefaultContext(options.projectRoot ?? process.cwd())
  return [
    {
      id: 'runtime',
      title: 'Runtime',
      checks: [checkNodeVersion(ctx), checkCliHost(ctx)]
    },
    {
      id: 'hardware',
      title: 'Hardware',
      checks: [
        checkTotalMemory(ctx),
        checkAvailableMemory(ctx),
        checkGpuAcceleration(ctx),
        checkFreeDiskSpace(ctx)
      ]
    },
    {
      id: 'targets',
      title: 'Deploy targets (SDK)',
      checks: [checkDesktopTargets(ctx), checkAndroidTarget(ctx), checkIosTarget(ctx)]
    },
    {
      id: 'tools',
      title: 'Optional tools',
      checks: [checkFfmpeg(ctx), checkBareRuntime(ctx), checkBun(ctx)]
    },
    {
      id: 'project',
      title: 'Project',
      checks: [checkSdkInstalled(ctx)]
    }
  ]
}

export function isReportOk(sections: CheckSection[]): boolean {
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.status === 'fail') return false
    }
  }
  return true
}
