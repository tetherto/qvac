// Error codes are read at import time to build lookup tables, so this stays a
// plain (empty) object rather than a throwing placeholder.
export const ERR_CODES: Record<string, number> = {}
export default { ERR_CODES }
