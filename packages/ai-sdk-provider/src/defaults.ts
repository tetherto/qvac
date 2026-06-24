// TODO(QVAC-19194): PLACEHOLDER baseURL — pending the CLI port-change ticket.
// `qvac serve` currently defaults to 11434, which collides with Ollama. We
// intentionally do NOT default to 11434 here so the provider's default
// doesn't become a foot-gun once the CLI moves to a non-conflicting port.
// Callers MUST set `baseURL` explicitly until this default is finalized;
// the README highlights this. Replace `11435` with the real CLI default
// (and remove this TODO) when the CLI ticket lands.
export const DEFAULT_BASE_URL = 'http://127.0.0.1:11435/v1'

// `qvac serve` does not validate the API key. The value is sent only because
// some OpenAI-shaped HTTP clients refuse to issue a request without an
// Authorization header. Override with `apiKey` for downstream proxies that
// do enforce a key.
export const DEFAULT_API_KEY = 'qvac'

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({})

// ── Managed mode ────────────────────────────────────────────────────────────

// Host the spawned `qvac serve` binds to. Loopback only — managed mode is for
// the single-machine "run it for me" case, never a public listener.
export const DEFAULT_SERVE_HOST = '127.0.0.1'

// Max time to wait for the serve to answer `GET /v1/models`. The port stays
// closed until preload finishes and a cold P2P download can take minutes, so
// this is deliberately generous.
export const DEFAULT_SERVE_START_TIMEOUT_MS = 180_000

// Interval between health-check polls while waiting for startup.
export const SERVE_HEALTH_POLL_INTERVAL_MS = 250

// Grace period between SIGTERM and SIGKILL during shutdown, mirroring the
// CLI's own `close-with-grace` ladder.
export const SERVE_SHUTDOWN_GRACE_MS = 5_000

// How long a shared managed serve keeps running after its last consumer
// process has gone away. A short grace window lets a quick restart (or a second
// session) re-attach to the warm serve instead of paying another cold start.
export const DEFAULT_SERVE_IDLE_TIMEOUT_MS = 300_000 // 5 minutes

// How often the detached runner re-checks its consumer set / idle deadline.
export const RUNNER_POLL_INTERVAL_MS = 2_000

// How often a `closeOnParentExit` provider polls its parent pid. A dead parent
// reparents us (ppid → 1 on POSIX) effectively instantly; this only bounds the
// detection latency, so a couple of seconds is plenty.
export const PARENT_WATCH_INTERVAL_MS = 2_000

// How long a spawn lockfile is considered fresh. Past this it is treated as
// stale (left by a crashed spawner) and may be stolen.
export const SPAWN_LOCK_STALE_MS = 30_000
