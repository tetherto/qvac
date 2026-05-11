// Action entrypoint. Reads inputs, runs the gate, writes the output.
//
// Exit policy:
//   - Hard misconfiguration (missing token, unreadable event payload,
//     unhandled API error) -> non-zero exit so the gate job goes red and
//     someone notices.
//   - Soft denial (label not applied, applier not trusted, etc.) ->
//     exit 0 with `authorised=false`. Downstream jobs gate on the output.

import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GitHubClient, GitHubApiError } from './github-client.mjs';
import { gate, parseList, loadEventPayload } from './gate.mjs';

const annotate = (level, message) => {
  process.stdout.write(`::${level} title=label-gate::${message}\n`);
};
const notice = (m) => annotate('notice', m);
const warning = (m) => annotate('warning', m);
const error = (m) => annotate('error', m);

// Exported for unit tests; index.mjs is the only production caller.
export function getInput(name, { required = false, env = process.env } = {}) {
  // Match the GitHub Actions runner / @actions/core convention exactly:
  // INPUT_<NAME> where <NAME> uppercases the input and replaces spaces
  // (NOT hyphens) with underscores. Hyphens are preserved verbatim, so
  // `github-token` becomes `INPUT_GITHUB-TOKEN`. Hyphens in env-var
  // names are technically non-POSIX but Node.js exposes them via
  // process.env regardless. An earlier impl replaced hyphens with
  // underscores too, which silently lost any hyphenated input — caught
  // by the QVAC-18612 canary; the regression test below pins this for
  // good.
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const raw = env[key];
  const value = raw == null ? '' : raw.trim();
  if (required && !value) {
    throw new Error(`required input '${name}' is missing`);
  }
  return value;
}

async function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) throw new Error('GITHUB_OUTPUT is not set');
  await appendFile(file, `${name}=${value}\n`);
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!eventName) throw new Error('GITHUB_EVENT_NAME is not set');
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');

  const label = getInput('label') || 'verified';
  const teams = parseList(getInput('teams'));
  const users = parseList(getInput('users'));
  const token = getInput('github-token', { required: true });

  if (teams.length === 0 && users.length === 0) {
    warning(
      'both `teams` and `users` are empty — every PR-event run will be denied'
    );
  }

  let payload = {};
  if (eventPath) {
    payload = await loadEventPayload(eventPath);
  } else if (
    eventName === 'pull_request' ||
    eventName === 'pull_request_target'
  ) {
    throw new Error('GITHUB_EVENT_PATH is required for PR events');
  }

  const client = new GitHubClient({ token, repo });

  const decision = await gate({
    eventName,
    payload,
    repo,
    label,
    teams,
    users,
    client,
  });

  if (decision.applier) notice(`label applier resolved: '${decision.applier}'`);
  if (decision.stripped) warning(`stripped '${label}' label`);

  notice(`authorised=${decision.authorised} (${decision.reason})`);
  await setOutput('authorised', decision.authorised ? 'true' : 'false');
}

// Only execute when invoked as the action entrypoint (`node src/index.mjs`).
// When imported by the test suite the top-level main() must not run.
const invokedDirectly =
  process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    if (e instanceof GitHubApiError) {
      error(
        `GitHub API error: ${e.message} (status=${e.status} method=${e.method} path=${e.path})`
      );
    } else {
      error(`unexpected failure: ${e.message ?? e}`);
    }
    process.exitCode = 1;
  });
}
