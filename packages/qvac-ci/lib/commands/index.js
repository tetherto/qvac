// Command registry — add new commands here.
// Each entry calls .toCommand() so main.js can spread the array directly.
import pendingApprovals from './pending-approvals/index.js'

export const commands = [
  pendingApprovals.toCommand()
]
