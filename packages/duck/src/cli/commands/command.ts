import { command as define } from 'paparam'
import type { Command, Part } from 'paparam'
import type { CoreHost, LauncherRunner, RuntimeOptions } from '../../lib/types.js'
import type { CommandIO } from '../io.js'
export type CoreRunner = (
  host: CoreHost,
  options: RuntimeOptions,
  io: CommandIO
) => Promise<number | void> | number | void
export type CommandRoute =
  | { where: 'core'; run: CoreRunner }
  | { where: 'launcher' | 'app'; run: LauncherRunner }
  | { where?: null; run?: null }
export type RoutedCommand = Command & { qvac: CommandRoute }
export function command(name: string, route: CommandRoute = {}, ...parts: Part[]): RoutedCommand {
  return Object.assign(define(name, ...parts), { qvac: route })
}
