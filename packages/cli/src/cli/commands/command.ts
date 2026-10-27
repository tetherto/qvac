import { command as define } from 'paparam'
import type { Command, Part } from 'paparam'
import type { CoreRunner, LauncherRunner } from '../../lib/types.js'
export type CommandRoute =
  | { where: 'core'; run: CoreRunner }
  | { where: 'launcher' | 'app'; run: LauncherRunner }
  | { where?: null; run?: null }
export type RoutedCommand = Command & { qvac: CommandRoute }
export function command(name: string, route: CommandRoute = {}, ...parts: Part[]): RoutedCommand {
  return Object.assign(define(name, ...parts), { qvac: route })
}
