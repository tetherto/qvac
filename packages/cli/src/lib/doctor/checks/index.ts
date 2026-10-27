import type { CheckContext } from '@/lib/doctor/check'
import { createDefaultContext } from '@/lib/doctor/check'
import type { CheckSection } from '@/lib/doctor/types'
import { checkNodeVersion, checkCliHost } from '@/lib/doctor/checks/runtime'
import {
  checkTotalMemory,
  checkAvailableMemory,
  checkGpuAcceleration,
  checkFreeDiskSpace
} from '@/lib/doctor/checks/hardware'
import {
  checkDesktopTargets,
  checkAndroidTarget,
  checkIosTarget
} from '@/lib/doctor/checks/targets'
import { checkFfmpeg, checkBareRuntime } from '@/lib/doctor/checks/tools'
import { checkSdkInstalled } from '@/lib/doctor/checks/project'

export type { Check, CheckContext, ProbeFn, ProbeResult } from '@/lib/doctor/check'
export { createDefaultContext, probeBinary } from '@/lib/doctor/check'
export { checkNodeVersion, checkCliHost } from '@/lib/doctor/checks/runtime'
export {
  checkTotalMemory,
  checkAvailableMemory,
  checkGpuAcceleration,
  checkFreeDiskSpace
} from '@/lib/doctor/checks/hardware'
export {
  checkDesktopTargets,
  checkAndroidTarget,
  checkIosTarget
} from '@/lib/doctor/checks/targets'
export { checkFfmpeg, checkBareRuntime } from '@/lib/doctor/checks/tools'
export { checkSdkInstalled } from '@/lib/doctor/checks/project'
export { checkBareEngines } from '@/lib/doctor/checks/engines'

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
      checks: [checkFfmpeg(ctx), checkBareRuntime(ctx)]
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
