import { clearSessions, openSession } from '@/runtime/session-registry'

/**
 * Opens the caller sessions a test sends requests under, since the request
 * registry refuses a request whose session is not open. Clears the session
 * registry before and after the test.
 */
export function openTestSessions(t: { teardown(fn: () => void): void }, ...ids: string[]): void {
  clearSessions()
  for (const id of ids) openSession(id)
  t.teardown(() => clearSessions())
}
