#!/usr/bin/env bun
/**
 * Replays every URL the site owes a reader against the built output, and
 * fails if any of them stops resolving.
 *
 * Two sets are replayed, one per reorganization:
 *
 *   - `tests/fixtures/pre-move-urls.json` — what production serves today. The
 *     collections reorganization puts a collection name in front of all 69
 *     pages, so every public URL changes at once and each one depends on a
 *     redirect. This is the only set readers, search engines, and external
 *     links actually point at.
 *   - `tests/fixtures/pre-versioning-urls.json` — the same set as the
 *     collections reorganization leaves it, replayed before the collections
 *     are cut into documentation lines. Almost nothing moves: the cut keeps
 *     the version-less paths answering from the current line, so these URLs
 *     are expected to resolve on their own, and the fixture is here to prove
 *     that they still do. The exception is the sixteen retired patch-series
 *     archives, which leave the published set and redirect.
 *
 * A missing or mis-ordered rule is invisible in the diff and only shows up as
 * a 404 in production, on a URL search engines and external links already
 * point at. Each entry is resolved through `public/_redirects` exactly as the
 * CDN would, and asserted to land on a file that exists, within the number of
 * redirects that set is allowed.
 *
 * The CDN behaviours modelled here are the ones `public/_redirects` documents
 * at length, because they are what makes rule order matter:
 *
 *   - Static files resolve before the rules, which is why a rule needs the `!`
 *     flag to shadow an existing page.
 *   - Pretty URLs normalizes a bare path to its trailing-slash form, but skips
 *     paths whose last segment contains a dot (`v0.7.x`), which is why those
 *     sections need explicit `200` rewrites.
 *   - First match wins, and a `200` rewrite pointing at a file that was never
 *     built keeps falling through to the catch-all 404.
 *
 * Rules carrying a `Header:` condition are skipped: they only fire for a
 * client that sends that header, and the replay models a plain page request.
 *
 * Usage (after `npm run build`):
 *   bun run scripts/check-redirects.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import type { UrlInventory } from "./capture-url-inventory.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const OUT_DIR = path.join(DOCS_WEBSITE_DIR, "out");
const REDIRECTS_PATH = path.join(DOCS_WEBSITE_DIR, "public", "_redirects");
const FIXTURES_DIR = path.join(DOCS_WEBSITE_DIR, "tests", "fixtures");

/** A redirect chain longer than this is treated as a loop. */
const MAX_HOPS = 5;

interface Fixture {
  file: string;
  label: string;
  /**
   * The most redirects any URL of this set may need to reach its page. A
   * chain that grows past it still resolves, so nothing else would report
   * it, but it means a reader is being bounced through an intermediate URL
   * that a rule could have skipped.
   */
  maxRedirects: number;
}

const FIXTURES: Fixture[] = [
  // Two hops for the retired archives: the generated block sends the
  // pre-collections URL to its collection-scoped twin, which is the URL the
  // retirement rule then sends to the current page. Collapsing it would mean
  // hand-editing the generated block.
  { file: "pre-move-urls.json", label: "pre-move", maxRedirects: 2 },
  {
    file: "pre-versioning-urls.json",
    label: "pre-versioning",
    maxRedirects: 1,
  },
];

interface Rule {
  line: number;
  from: string;
  to: string;
  status: number;
  /** The `!` flag: the rule fires even when a static file would answer. */
  force: boolean;
  conditional: boolean;
}

export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [from, to, statusToken = "301", ...rest] = line.split(/\s+/);
    if (!from || !to) return;
    rules.push({
      line: index + 1,
      from,
      to,
      status: Number.parseInt(statusToken, 10),
      force: statusToken.endsWith("!"),
      conditional: rest.some((token) => token.startsWith("Header:")),
    });
  });
  return rules;
}

function segments(url: string): string[] {
  return url.split("/").filter((segment) => segment !== "");
}

/**
 * Sevalla's placeholder matcher is lenient about a trailing slash in the
 * source pattern, so `/a/:v` matches both `/a/x` and `/a/x/`. Placeholders
 * match exactly one segment; a trailing `*` matches the rest of the path.
 */
export function matchRule(
  rule: Rule,
  url: string,
): Record<string, string> | null {
  const pattern = segments(rule.from);
  const actual = segments(url);
  const params: Record<string, string> = {};

  for (let i = 0; i < pattern.length; i++) {
    const token = pattern[i];
    if (token === "*") {
      params.splat = actual.slice(i).join("/");
      return params;
    }
    if (i >= actual.length) return null;
    if (token.startsWith(":")) {
      params[token.slice(1)] = actual[i];
      continue;
    }
    if (token !== actual[i]) return null;
  }

  return pattern.length === actual.length ? params : null;
}

function expand(target: string, params: Record<string, string>): string {
  return target.replace(/:([a-zA-Z]+)|\*/g, (token) =>
    token === "*" ? (params.splat ?? "") : (params[token.slice(1)] ?? token),
  );
}

/** True when the last path segment carries a dot, e.g. `v0.7.x` or `page.md`. */
function hasDottedTail(url: string): boolean {
  const tail = segments(url).at(-1);
  return tail !== undefined && tail.includes(".");
}

/**
 * The file the CDN serves for a URL without consulting any rule, or null when
 * static resolution misses.
 */
function staticFileFor(url: string, built: Set<string>): string | null {
  const clean = url.split(/[#?]/)[0];
  const direct = clean.replace(/^\//, "");
  if (built.has(direct)) return direct;
  // Pretty URLs skips dotted tails, so they never gain a directory index.
  if (hasDottedTail(clean)) return null;
  const index = path.posix.join(direct, "index.html");
  return built.has(index) ? index : null;
}

interface Resolution {
  ok: boolean;
  chain: string[];
  reason?: string;
}

export function resolve(
  url: string,
  rules: Rule[],
  built: Set<string>,
): Resolution {
  const chain: string[] = [url];
  let current = url;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const forced = rules.some(
      (rule) => rule.force && !rule.conditional && matchRule(rule, current),
    );
    if (!forced && staticFileFor(current, built)) return { ok: true, chain };

    let served = false;
    let redirectTo: string | null = null;
    let reason: string | null = null;

    for (const rule of rules) {
      if (rule.conditional) continue;
      const params = matchRule(rule, current);
      if (!params) continue;
      const target = expand(rule.to, params);

      if (rule.status === 404) {
        reason = `caught by the 404 rule (line ${rule.line})`;
        break;
      }
      if (rule.status === 200) {
        // A rewrite whose target was never built keeps falling through to the
        // rules below it, so it does not resolve the request.
        if (built.has(target.replace(/^\//, ""))) served = true;
        if (served) break;
        continue;
      }
      redirectTo = target;
      break;
    }

    if (served) return { ok: true, chain };
    if (reason) return { ok: false, chain, reason };
    if (redirectTo === null) {
      return { ok: false, chain, reason: "no rule matched and no file exists" };
    }

    chain.push(redirectTo);
    current = redirectTo;
  }

  return {
    ok: false,
    chain,
    reason: `still redirecting after ${MAX_HOPS} hops`,
  };
}

async function builtFiles(): Promise<Set<string>> {
  const entries = await fs.readdir(OUT_DIR, {
    withFileTypes: true,
    recursive: true,
  });
  const files = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files.add(path.relative(OUT_DIR, path.join(entry.parentPath, entry.name)));
  }
  return files;
}

/**
 * A non-forced rule whose source is answered by a static file can never fire.
 * That is how a stale rule turns into a redirect away from a page that now
 * lives at exactly that URL.
 */
function shadowedRules(rules: Rule[], built: Set<string>): Rule[] {
  return rules.filter(
    (rule) =>
      !rule.force &&
      !rule.conditional &&
      rule.status !== 404 &&
      !rule.from.includes(":") &&
      !rule.from.includes("*") &&
      staticFileFor(rule.from, built) !== null,
  );
}

async function main() {
  let built: Set<string>;
  try {
    built = await builtFiles();
  } catch {
    throw new Error(
      `No build output at ${OUT_DIR}. Run \`npm run build\` before checking.`,
    );
  }

  const rules = parseRules(await fs.readFile(REDIRECTS_PATH, "utf-8"));

  const failures: Array<{ url: string; resolution: Resolution }> = [];
  const detours: string[] = [];
  const replayed: string[] = [];

  for (const fixture of FIXTURES) {
    const inventory: UrlInventory = JSON.parse(
      await fs.readFile(path.join(FIXTURES_DIR, fixture.file), "utf-8"),
    );
    const urls = [...inventory.pages, ...inventory.markdown];

    for (const url of urls) {
      const resolution = resolve(url, rules, built);
      if (!resolution.ok) {
        failures.push({ url, resolution });
        continue;
      }
      const redirects = resolution.chain.length - 1;
      if (redirects > fixture.maxRedirects) {
        detours.push(
          `${url} — ${redirects} redirects, ${fixture.label} allows ${fixture.maxRedirects}\n    ${resolution.chain.join(" → ")}`,
        );
      }
    }

    replayed.push(
      `${urls.length} ${fixture.label} URLs (${inventory.pages.length} pages + ${inventory.markdown.length} Markdown twins)`,
    );
  }

  // The rules predating this fixture — the older IA still linked from
  // qvac.tether.io — get the same treatment: a rule whose target no longer
  // exists is a 404 with extra steps.
  for (const rule of rules) {
    if (rule.conditional || rule.status !== 301) continue;
    if (rule.to.includes(":") || rule.to.includes("*")) continue;
    const resolution = resolve(rule.to, rules, built);
    if (!resolution.ok) {
      failures.push({ url: `${rule.from} (line ${rule.line})`, resolution });
    }
  }

  const shadowed = shadowedRules(rules, built);

  if (failures.length > 0 || detours.length > 0 || shadowed.length > 0) {
    for (const { url, resolution } of failures) {
      console.error(
        `✗ ${url} — ${resolution.reason}\n    ${resolution.chain.join(" → ")}`,
      );
    }
    for (const detour of detours) {
      console.error(`✗ ${detour}`);
    }
    for (const rule of shadowed) {
      console.error(
        `✗ _redirects line ${rule.line}: \`${rule.from}\` is a live page, so this rule never fires`,
      );
    }
    throw new Error(
      `${failures.length} URL(s) no longer resolve, ${detours.length} take more redirects than allowed, ${shadowed.length} rule(s) shadowed by a live page`,
    );
  }

  console.log(`All previously served URLs still resolve: ${replayed.join(", ")}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
