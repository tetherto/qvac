/**
 * Session id of the runtime owner: the process that started the engine and
 * calls it without a session handle. Requests without a `sessionId` run as
 * this session. It is never accepted on the wire (`openSession` refuses it and
 * a request naming it fails the open-session check), so a client cannot act as
 * the owner by sending the string.
 */
export const OWNER_SESSION_ID = 'owner'

/** The session a request runs as: its `sessionId`, or the owner when absent. */
export function resolveSessionId(request: { sessionId?: string | undefined }): string {
  return request.sessionId ?? OWNER_SESSION_ID
}

/**
 * Key the request registry stores a request under. The session id prefix is
 * fixed by the dispatcher, so a client that puts the NUL separator in its own
 * ids can only collide with its own requests.
 */
export function requestRegistryKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}
