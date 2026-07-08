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
  const envConfig: Record<string, string | undefined> = {
    HOME_DIR: defaultHomeDir
  }

  // On the mobile bare-kit host the app passes HOME as the first argv entry.
  const isBareKit = typeof (globalThis as { BareKit?: unknown }).BareKit !== 'undefined'
  if (isBareKit && Bare.argv[0]) {
    envConfig['HOME_DIR'] = Bare.argv[0]
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
