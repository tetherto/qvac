import env from 'bare-env'
import { z } from 'zod'

const envSchema = z.object({
  HOME_DIR: z.string()
})

type Env = z.infer<typeof envSchema>

let validatedEnv: Env | null = null

/**
 * Initialize the environment. Call once at startup.
 */
export function initEnv(): void {
  const defaultHomeDir =
    // Snap's HOME can be revision-scoped; SNAP_USER_COMMON is stable.
    env['SNAP_USER_COMMON'] ?? env['HOME'] ?? env['USERPROFILE'] ?? '/tmp'
  let envConfig: Record<string, string | undefined> = {
    HOME_DIR: defaultHomeDir
  }

  const isBareKit = typeof (globalThis as { BareKit?: unknown }).BareKit !== 'undefined'
  // The browser build has no Bare global and so no arguments.
  const argv = (globalThis as { Bare?: { argv: string[] } }).Bare?.argv ?? []
  if (isBareKit && argv[0]) {
    envConfig['HOME_DIR'] = argv[0]
  }

  if (argv[2]) {
    try {
      const overrides = JSON.parse(argv[2]) as Record<string, string>
      envConfig = { ...envConfig, ...overrides }
    } catch {
      // Ignore non-JSON args
    }
  }

  validatedEnv = envSchema.parse(envConfig)
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
