import { readPackageContributions } from './contribution.ts'
import type { FinalizeAssistantStackOptions } from './types.ts'
import { writeAssistantStackArtifacts } from '../packaging/stack-manifest.ts'

export async function finalizeAssistantStack(
  projectRoot: string,
  options: FinalizeAssistantStackOptions = {}
) {
  const builtWorkers = await readPackageContributions(projectRoot, {
    syncContribution: options.syncContribution,
    harnessContribution: options.harnessContribution
  })
  await writeAssistantStackArtifacts(
    projectRoot,
    builtWorkers,
    options.pinLinkerRoot === true
  )
}
