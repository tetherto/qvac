import env from 'bare-env'
import { z } from 'zod'

const envSchema = z.object({
  HOME_DIR: z.string()
})

type Env = z.infer<typeof envSchema>

export interface EnvOptions {
  /** Folder that holds `.qvac`. Defaults to the user's home folder. */
  homeDir?: string | undefined
}

let validatedEnv: Env | null = null

function defaultHomeDir(): string {
  // Snap's HOME can be revision-scoped; SNAP_USER_COMMON is stable.
  return env['SNAP_USER_COMMON'] ?? env['HOME'] ?? env['USERPROFILE'] ?? '/tmp'
}

/**
 * Initialize the environment. Call once at startup.
 */
export function initEnv(options: EnvOptions = {}): void {
  validatedEnv = envSchema.parse({ HOME_DIR: options.homeDir ?? defaultHomeDir() })
}

/**
 * Get the engine environment. Must call initEnv() first.
 */
export function getEnv() {
  if (!validatedEnv) {
    // Fallback initialization for cases where initEnv wasn't called
    initEnv()
  }
  return {
    ...env,
    ...validatedEnv!
  }
}

/**
 * Get the validated env config. Must call initEnv() first.
 */
export function getValidatedEnv() {
  if (!validatedEnv) {
    initEnv()
  }
  return validatedEnv!
}
