import type { CheckContext } from '../check.js'
import { createDefaultContext } from '../check.js'
import type { CheckSection } from '../types.js'
import { checkNodeVersion, checkCliHost } from './runtime.js'
import { checkTotalMemory, checkAvailableMemory, checkGpuAcceleration, checkFreeDiskSpace } from './hardware.js'
import { checkDesktopTargets, checkAndroidTarget, checkIosTarget } from './targets.js'
import { checkFfmpeg, checkBareRuntime, checkBun } from './tools.js'
import { checkSdkInstalled } from './project.js'

export type { Check, CheckContext, ProbeFn, ProbeResult } from '../check.js'
export { createDefaultContext, probeBinary } from '../check.js'
export { checkNodeVersion, checkCliHost } from './runtime.js'
export { checkTotalMemory, checkAvailableMemory, checkGpuAcceleration, checkFreeDiskSpace } from './hardware.js'
export { checkDesktopTargets, checkAndroidTarget, checkIosTarget } from './targets.js'
export { checkFfmpeg, checkBareRuntime, checkBun } from './tools.js'
export { checkSdkInstalled } from './project.js'

export interface CollectChecksOptions {
  context?: CheckContext | undefined
  projectRoot?: string | undefined
}

export function collectCheckSections (options: CollectChecksOptions = {}): CheckSection[] {
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
      checks: [checkTotalMemory(ctx), checkAvailableMemory(ctx), checkGpuAcceleration(ctx), checkFreeDiskSpace(ctx)]
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

export function isReportOk (sections: CheckSection[]): boolean {
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.status === 'fail') return false
    }
  }
  return true
}
