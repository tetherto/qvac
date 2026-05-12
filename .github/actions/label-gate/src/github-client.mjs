// Minimal GitHub REST client for label-gate.
//
// Uses Node 20+ built-in fetch. Implements only the three endpoints the
// gate needs, with retry-on-5xx, full pagination on the timeline, and
// idempotent semantics for label deletion.
//
// Designed for dependency injection: the gate function receives an instance
// of this class (or a test double) so unit tests don't touch the network.

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'label-gate/1.0 (+github.com/tetherto/qvac)';
const DEFAULT_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': USER_AGENT,
};

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse the `Link` response header and return the URL of the `rel="next"`
 * page, or null if there is no next page.
 *
 * @param {string | null | undefined} header
 * @returns {string | null}
 */
export function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Thrown for unexpected GitHub API responses (after retries).
 */
export class GitHubApiError extends Error {
  constructor(message, { status, method, path, body } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

export class GitHubClient {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {string} opts.repo - "owner/name"
   * @param {typeof globalThis.fetch} [opts.fetchImpl]
   * @param {(ms: number) => Promise<void>} [opts.sleepImpl]
   * @param {number} [opts.maxAttempts]
   */
  constructor({ token, repo, fetchImpl, sleepImpl, maxAttempts } = {}) {
    if (!token) throw new Error('GitHubClient: token is required');
    if (!repo || !repo.includes('/')) {
      throw new Error('GitHubClient: repo must be "owner/name"');
    }
    this.token = token;
    this.repo = repo;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.sleep = sleepImpl ?? sleep;
    this.maxAttempts = maxAttempts ?? MAX_ATTEMPTS;
  }

  get [Symbol.toStringTag]() {
    return 'GitHubClient';
  }

  /**
   * Single API request with retries on 5xx and 429.
   *
   * @returns {Promise<{status: number, headers: Headers, body: unknown}>}
   */
  async _requestOnce(method, url) {
    const res = await this.fetch(url, {
      method,
      headers: {
        ...DEFAULT_HEADERS,
        Authorization: `Bearer ${this.token}`,
      },
    });

    let body;
    if (res.status === 204) {
      body = null;
    } else {
      const text = await res.text();
      body = text.length === 0 ? null : safeJson(text);
    }
    return { status: res.status, headers: res.headers, body };
  }

  async _request(method, path) {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    let lastErr;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this._requestOnce(method, url);
        const retriable = res.status >= 500 || res.status === 429;
        if (!retriable) return res;
        lastErr = new GitHubApiError(
          `GitHub ${method} ${path} -> HTTP ${res.status}`,
          { status: res.status, method, path, body: res.body }
        );
      } catch (e) {
        lastErr = e;
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    throw lastErr;
  }

  /**
   * Check whether `login` is an active member of `org/team`.
   *
   * Returns false on 404 (the canonical "not a member" response from
   * GitHub). Throws on any other unexpected status.
   */
  async isTeamMember(org, team, login) {
    if (!login) return false;
    const path = `/orgs/${enc(org)}/teams/${enc(team)}/memberships/${enc(login)}`;
    const res = await this._request('GET', path);
    if (res.status === 404) return false;
    if (res.status >= 400) {
      throw new GitHubApiError(
        `team membership check failed: HTTP ${res.status}`,
        { status: res.status, method: 'GET', path, body: res.body }
      );
    }
    return res.body?.state === 'active';
  }

  /**
   * Walk the issue timeline and return the login of the user who applied
   * the most recent matching `labeled` event for `label`. Returns null if
   * no such event exists.
   */
  async findLabelApplier(prNumber, label) {
    const events = [];
    let next = `/repos/${this.repo}/issues/${prNumber}/timeline?per_page=100`;
    let pages = 0;
    const MAX_PAGES = 50; // 5,000 events; well past anything realistic
    while (next && pages < MAX_PAGES) {
      const res = await this._request('GET', next);
      if (res.status >= 400) {
        throw new GitHubApiError(
          `timeline fetch failed: HTTP ${res.status}`,
          { status: res.status, method: 'GET', path: next, body: res.body }
        );
      }
      if (Array.isArray(res.body)) events.push(...res.body);
      next = parseNextLink(res.headers.get('link'));
      pages += 1;
    }

    let latest = null;
    let latestAt = -Infinity;
    for (const ev of events) {
      if (ev?.event !== 'labeled') continue;
      if (ev?.label?.name !== label) continue;
      const ts = ev.created_at ? Date.parse(ev.created_at) : NaN;
      if (Number.isFinite(ts) && ts >= latestAt) {
        latestAt = ts;
        latest = ev.actor?.login ?? null;
      }
    }
    return latest;
  }

  /**
   * Best-effort label removal. Returns true if the label was present and
   * removed, false if it was already absent (404). Throws on any other
   * unexpected status.
   */
  async stripLabel(prNumber, label) {
    const path = `/repos/${this.repo}/issues/${prNumber}/labels/${enc(label)}`;
    const res = await this._request('DELETE', path);
    if (res.status === 200 || res.status === 204) return true;
    if (res.status === 404) return false;
    throw new GitHubApiError(
      `label strip failed: HTTP ${res.status}`,
      { status: res.status, method: 'DELETE', path, body: res.body }
    );
  }
}

function enc(s) {
  return encodeURIComponent(String(s));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
