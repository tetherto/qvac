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
