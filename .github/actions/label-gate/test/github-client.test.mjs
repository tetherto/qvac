// Unit tests for the GitHubClient HTTP layer.
//
// fetch and sleep are injected; no network is touched. We assert the
// retry policy, pagination, 404-as-not-member semantics, and the
// idempotent strip behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubClient,
  GitHubApiError,
  parseNextLink,
} from '../src/github-client.mjs';

function makeFetch(handlers) {
  let i = 0;
  return async (url) => {
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected fetch call: ${url}`);
    if (handler.match) assert.match(url, handler.match);
    return makeResponse(handler);
  };
}

function makeResponse({ status = 200, body = null, headers = {} } = {}) {
  const text =
    body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get: (k) => headers[k.toLowerCase()] ?? null,
    },
    text: async () => text,
  };
}

function makeClient(handlers, { sleeps = [] } = {}) {
  const fetchImpl = makeFetch(handlers);
  const sleepImpl = async (ms) => sleeps.push(ms);
  return {
    client: new GitHubClient({
      token: 't',
      repo: 'o/r',
      fetchImpl,
      sleepImpl,
    }),
    sleeps,
  };
}

// --- parseNextLink ------------------------------------------------------------

test('parseNextLink: extracts next URL', () => {
  const header =
    '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
  assert.equal(
    parseNextLink(header),
    'https://api.github.com/x?page=2'
  );
});

test('parseNextLink: returns null when no next', () => {
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink(''), null);
  assert.equal(
    parseNextLink('<https://api.github.com/x?page=5>; rel="last"'),
    null
  );
});

// --- constructor validation --------------------------------------------------

test('constructor: rejects missing token', () => {
  assert.throws(
    () => new GitHubClient({ repo: 'o/r' }),
    /token is required/
  );
});

test('constructor: rejects malformed repo', () => {
  assert.throws(
    () => new GitHubClient({ token: 't', repo: 'no-slash' }),
    /must be "owner\/name"/
  );
});

// --- isTeamMember ------------------------------------------------------------

test('isTeamMember: true when state=active', async () => {
  const { client } = makeClient([
    { match: /\/orgs\/o\/teams\/t\/memberships\/u/, body: { state: 'active' } },
  ]);
  assert.equal(await client.isTeamMember('o', 't', 'u'), true);
});

test('isTeamMember: false on 404 (not a member)', async () => {
  const { client } = makeClient([
    { status: 404, body: { message: 'Not Found' } },
  ]);
  assert.equal(await client.isTeamMember('o', 't', 'u'), false);
});

test('isTeamMember: false on state=pending', async () => {
  const { client } = makeClient([{ body: { state: 'pending' } }]);
  assert.equal(await client.isTeamMember('o', 't', 'u'), false);
});

test('isTeamMember: throws on unexpected status', async () => {
  const { client } = makeClient([{ status: 403, body: { message: 'forbidden' } }]);
  await assert.rejects(
    () => client.isTeamMember('o', 't', 'u'),
    GitHubApiError
  );
});

test('isTeamMember: empty login -> false, no fetch', async () => {
  let called = false;
  const client = new GitHubClient({
    token: 't',
    repo: 'o/r',
    fetchImpl: async () => {
      called = true;
      return makeResponse({});
    },
  });
  assert.equal(await client.isTeamMember('o', 't', ''), false);
  assert.equal(called, false);
});

// --- retries ----------------------------------------------------------------

test('retries: 5xx -> 5xx -> 200, sleeps with backoff', async () => {
  const { client, sleeps } = makeClient([
    { status: 500, body: 'oops' },
    { status: 502, body: 'oops' },
    { body: { state: 'active' } },
  ]);
  assert.equal(await client.isTeamMember('o', 't', 'u'), true);
  assert.deepEqual(sleeps, [250, 500]);
});

test('retries: 5xx exhausted -> throws GitHubApiError', async () => {
  const { client } = makeClient([
    { status: 500, body: 'oops' },
    { status: 500, body: 'oops' },
    { status: 500, body: 'oops' },
  ]);
  await assert.rejects(
    () => client.isTeamMember('o', 't', 'u'),
    (e) => e instanceof GitHubApiError && e.status === 500
  );
});

test('retries: 429 is retried', async () => {
  const { client } = makeClient([
    { status: 429, body: { message: 'rate limited' } },
    { body: { state: 'active' } },
  ]);
  assert.equal(await client.isTeamMember('o', 't', 'u'), true);
});

// --- findLabelApplier --------------------------------------------------------

test('findLabelApplier: picks latest matching event across pages', async () => {
  const page1 = [
    {
      event: 'labeled',
      label: { name: 'verified' },
      actor: { login: 'first' },
      created_at: '2026-05-10T00:00:00Z',
    },
    {
      event: 'commented',
      actor: { login: 'noise' },
      created_at: '2026-05-10T01:00:00Z',
    },
    {
      event: 'labeled',
      label: { name: 'other-label' },
      actor: { login: 'wrong-label' },
      created_at: '2026-05-10T02:00:00Z',
    },
  ];
  const page2 = [
    {
      event: 'labeled',
      label: { name: 'verified' },
      actor: { login: 'middle' },
      created_at: '2026-05-10T03:00:00Z',
    },
  ];
  const page3 = [
    {
      event: 'labeled',
      label: { name: 'verified' },
      actor: { login: 'latest' },
      created_at: '2026-05-10T04:00:00Z',
    },
  ];
  const { client } = makeClient([
    {
      body: page1,
      headers: {
        link:
          '<https://api.github.com/repos/o/r/issues/1/timeline?page=2>; rel="next"',
      },
    },
    {
      body: page2,
      headers: {
        link:
          '<https://api.github.com/repos/o/r/issues/1/timeline?page=3>; rel="next"',
      },
    },
    { body: page3 },
  ]);
  assert.equal(await client.findLabelApplier(1, 'verified'), 'latest');
});

test('findLabelApplier: returns null when no matching event', async () => {
  const { client } = makeClient([{ body: [] }]);
  assert.equal(await client.findLabelApplier(1, 'verified'), null);
});

// --- stripLabel --------------------------------------------------------------

test('stripLabel: 200 -> true', async () => {
  const { client } = makeClient([{ status: 200, body: [] }]);
  assert.equal(await client.stripLabel(1, 'verified'), true);
});

test('stripLabel: 204 -> true', async () => {
  const { client } = makeClient([{ status: 204 }]);
  assert.equal(await client.stripLabel(1, 'verified'), true);
});

test('stripLabel: 404 -> false (idempotent)', async () => {
  const { client } = makeClient([{ status: 404, body: { message: 'no such label' } }]);
  assert.equal(await client.stripLabel(1, 'verified'), false);
});

test('stripLabel: unexpected status throws', async () => {
  const { client } = makeClient([{ status: 422, body: { message: 'bad' } }]);
  await assert.rejects(
    () => client.stripLabel(1, 'verified'),
    GitHubApiError
  );
});

test('stripLabel: URL-encodes label name with special characters', async () => {
  const { client } = makeClient([
    {
      match: /\/labels\/needs%20review/,
      status: 204,
    },
  ]);
  assert.equal(await client.stripLabel(1, 'needs review'), true);
});
