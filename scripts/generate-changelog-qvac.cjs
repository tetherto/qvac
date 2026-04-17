#!/usr/bin/env node

/**
 * Qvac (generic) changelog generator
 *
 * Generates changelog from merged PRs since the latest package tag,
 * scoped to a specific package path. Use for non-SDK-pod packages.
 *
 * CLI Usage:
 *   node scripts/generate-changelog-qvac.cjs --package=<name>
 *   node scripts/generate-changelog-qvac.cjs --package=<name> --base-commit=abc123 --base-version=0.5.0
 *
 * Programmatic Usage:
 *   const { generateChangelog } = require("./scripts/generate-changelog-qvac.cjs");
 *   const result = await generateChangelog({ packageName: "sdk" });
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * Execute git command
 * @param {string} command
 * @returns {string}
 */
function git(command) {
  try {
    return execSync(`git ${command}`, { encoding: "utf8" }).trim();
  } catch (error) {
    console.error(`Git command failed: git ${command}`);
    throw error;
  }
}

/**
 * Get the root directory of the git repository
 * @returns {string}
 */
function getRepoRoot() {
  return git("rev-parse --show-toplevel");
}

/**
 * Get GitHub API token from environment or GitHub CLI
 * @returns {string|null}
 */
function getGitHubToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    return envToken;
  }

  try {
    const ghToken = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (ghToken && ghToken.length > 0) {
      console.log("ℹ️  Using GitHub CLI (gh) authentication\n");
      return ghToken;
    }
  } catch (error) {
    // gh CLI not installed or not authenticated
  }

  return null;
}

/**
 * Find the latest tag for a package.
 *
 * In "minor" mode, returns the latest x.y.0 tag — the correct base for
 * minor/major releases where patches ship on separate release branches.
 * In "patch" mode, returns the absolute latest tag (current behavior).
 *
 * @param {string} packageName - e.g., "sdk"
 * @param {"minor"|"patch"} releaseType - which tag lineage to follow
 * @returns {string|null} - e.g., "sdk-v0.8.0" or null
 */
function getLatestTag(packageName, releaseType = "minor") {
  try {
    const tags = git(`tag --list "${packageName}-v*" --sort=-v:refname`);
    if (!tags) return null;

    const allTags = tags.split("\n").map((t) => t.trim()).filter(Boolean);
    if (allTags.length === 0) return null;

    if (releaseType === "minor") {
      const minorTags = allTags.filter((t) => t.match(/-v\d+\.\d+\.0$/));
      return minorTags[0] || allTags[0] || null;
    }

    return allTags[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Auto-detect release type from a semver version string.
 * If the patch component is 0 (e.g. "0.9.0"), it's a minor release.
 * Otherwise (e.g. "0.8.3"), it's a patch release.
 * @param {string} version - e.g., "0.9.0"
 * @returns {"minor"|"patch"}
 */
function detectReleaseType(version) {
  const parts = version.split(".");
  const patch = parseInt(parts[2] || "0", 10);
  return patch === 0 ? "minor" : "patch";
}

/**
 * Extract version string from a tag
 * @param {string} tag - e.g., "sdk-v1.2.3"
 * @returns {string|null} - e.g., "1.2.3"
 */
function extractVersionFromTag(tag) {
  if (!tag) return null;
  const match = tag.match(/-v(\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

/**
 * Resolve the base reference (commit/tag) for changelog generation
 * @param {string} packageName
 * @param {string|null} baseCommit - CLI override
 * @param {"minor"|"patch"} releaseType
 * @returns {string|null}
 */
function resolveBaseRef(packageName, baseCommit, releaseType = "minor") {
  if (baseCommit) {
    return baseCommit;
  }
  return getLatestTag(packageName, releaseType);
}

/**
 * Get PR numbers from path-scoped commits.
 * Searches all commits (not just merges) because squash-merged PRs
 * have only one parent but still contain "#123" in the commit message.
 * @param {string|null} baseRef - Tag, commit SHA, or null for all commits
 * @param {string} packagePath - e.g., "packages/sdk"
 * @returns {number[]}
 */
function getPRNumbers(baseRef, packagePath) {
  try {
    const range = baseRef ? `${baseRef}..HEAD` : "HEAD";
    // Use :(top) pathspec to resolve from repo root regardless of CWD
    const commits = git(
      `log ${range} --oneline -- ":(top)${packagePath}"`,
    );

    if (!commits) {
      return [];
    }

    const prNumbers = [];
    const lines = commits.split("\n");

    for (const line of lines) {
      // Match "Merge pull request #123" or "(#123)" squash-merge patterns
      const match = line.match(/#(\d+)/);
      if (match) {
        prNumbers.push(parseInt(match[1], 10));
      }
    }

    return [...new Set(prNumbers)].sort((a, b) => a - b);
  } catch (error) {
    return [];
  }
}

/**
 * Fetch PR metadata from GitHub API
 * @param {string} repo - Format: "owner/repo"
 * @param {number} prNumber
 * @param {string|null} token
 * @returns {Promise<{title: string, body: string, number: number}>}
 */
async function fetchPRMetadata(repo, prNumber, token) {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "changelog-generator",
  };

  if (token) {
    headers["Authorization"] = token.startsWith("ghp_")
      ? `Bearer ${token}`
      : `token ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    let errorDetails = `${response.status}: ${response.statusText}`;

    if (response.status === 401) {
      errorDetails += " - Invalid or expired token";
    } else if (response.status === 403) {
      errorDetails += token
        ? " - Token doesn't have access to this repository (needs 'repo' scope for private repos)"
        : " - Authentication required for private repositories. Set GITHUB_TOKEN or GH_TOKEN environment variable";
    } else if (response.status === 404) {
      errorDetails += " - PR not found (wrong repository or PR number)";
    }

    throw new Error(`GitHub API returned ${errorDetails}`);
  }

  const data = await response.json();
  return {
    title: data.title,
    body: data.body || "",
    number: data.number,
  };
}

/**
 * Get package.json version from a package directory
 * Resolves from git repo root to work regardless of CWD.
 * @param {string} packagePath - e.g., "packages/sdk"
 * @returns {string}
 */
function getPackageVersion(packagePath) {
  try {
    const repoRoot = getRepoRoot();
    const pkgJsonPath = path.join(repoRoot, packagePath, "package.json");
    const content = fs.readFileSync(pkgJsonPath, "utf8");
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch (error) {
    console.error(`Failed to get version from ${packagePath}/package.json`);
    throw error;
  }
}

/**
 * Get GitHub repo slug (owner/name) from git remote.
 * Tries "upstream" first (fork workflow), falls back to "origin".
 * @returns {string|null} - e.g., "tetherto/qvac"
 */
function getRepoFromRemote() {
  for (const remote of ["upstream", "origin"]) {
    try {
      const url = git(`remote get-url ${remote}`);
      // Match SSH (git@github.com:owner/repo.git) or HTTPS (https://github.com/owner/repo.git)
      const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      if (match) return match[1];
    } catch (error) {
      // Remote doesn't exist, try next
    }
  }
  return null;
}

/**
 * Generate a basic changelog markdown (non-SDK-specific)
 * @param {string} version
 * @param {Array<{number: number, title: string, body: string, url: string}>} prs
 * @returns {string}
 */
function generateBasicChangelog(version, prs) {
  let changelog = `# Changelog v${version}\n\n`;
  changelog += `Release Date: ${new Date().toISOString().split("T")[0]}\n\n`;
  changelog += `## Changes\n\n`;

  for (const pr of prs) {
    changelog += `- ${pr.title} ([#${pr.number}](${pr.url}))\n`;
  }

  return changelog;
}

/**
 * Parse CLI arguments
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const params = {};
  for (const arg of argv) {
    const [key, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    params[key.replace(/^--/, "")] = value;
  }
  return params;
}

/**
 * Main programmatic entry point
 * @param {object} options
 * @param {string} options.packageName - e.g., "sdk"
 * @param {string} [options.baseCommit] - Override tag lookup with a commit SHA
 * @param {string} [options.baseVersion] - Version label for display
 * @param {"minor"|"patch"} [options.releaseType] - Overrides auto-detection from package.json version
 * @param {boolean} [options.dryRun] - If true, don't write files
 * @returns {Promise<{packageName: string, baseRef: string|null, baseVersion: string|null, version: string, prs: Array}>}
 */
async function generateChangelog(options) {
  const { packageName, baseCommit, baseVersion, dryRun } = options;
  const packagePath = `packages/${packageName}`;

  // Verify git repo
  try {
    git("rev-parse --git-dir");
  } catch (error) {
    throw new Error("Not a git repository");
  }

  // Fetch tags — try upstream first (fork workflow), then origin
  console.log("📥 Fetching tags...");
  let tagsFetched = false;
  for (const remote of ["upstream", "origin"]) {
    try {
      git(`fetch ${remote} --tags`);
      tagsFetched = true;
      break;
    } catch (error) {
      // Remote doesn't exist or unreachable, try next
    }
  }
  if (!tagsFetched) {
    console.warn("⚠️  Failed to fetch tags from any remote, using local tags");
  }

  // Get current version from package.json
  const version = getPackageVersion(packagePath);

  // Determine release type: explicit override > auto-detect from version
  const releaseType = options.releaseType || detectReleaseType(version);
  console.log(`📦 Current version: ${version} (${releaseType} release)`);

  // Resolve base reference
  const baseRef = resolveBaseRef(packageName, baseCommit || null, releaseType);
  if (!baseRef) {
    throw new Error(
      `No tags found for ${packageName} and no --base-commit provided.\n` +
        `For initial release, use: --base-commit=<sha> --base-version=<version>`,
    );
  }

  const resolvedBaseVersion =
    baseVersion || extractVersionFromTag(baseRef) || null;

  console.log(`📌 Base reference: ${baseRef}`);
  if (resolvedBaseVersion) {
    console.log(`📌 Base version: ${resolvedBaseVersion}`);
  }
  console.log("");

  // Get PR numbers scoped to package path
  console.log("🔍 Finding merged PRs...");
  const prNumbers = getPRNumbers(baseRef, packagePath);

  if (prNumbers.length === 0) {
    console.log("No PRs found to generate changelog");
    return {
      packageName,
      baseRef,
      baseVersion: resolvedBaseVersion,
      version,
      prs: [],
    };
  }

  console.log(
    `  Found ${prNumbers.length} PRs: ${prNumbers.join(", ")}\n`,
  );

  // Resolve repo from git remote
  const repo = getRepoFromRemote();
  if (!repo) {
    throw new Error(
      "Could not determine GitHub repo from git remotes. Ensure 'upstream' or 'origin' points to GitHub.",
    );
  }

  // Get GitHub token
  const token = getGitHubToken();
  if (!token) {
    console.warn("⚠️  No GitHub token found.");
    console.warn(
      "    For private repositories, authenticate with one of these methods:",
    );
    console.warn(
      "    1. Install and authenticate with GitHub CLI: gh auth login",
    );
    console.warn(
      "    2. Set environment variable: export GITHUB_TOKEN=your_token",
    );
    console.warn(
      "    3. Create token at: https://github.com/settings/tokens (needs 'repo' scope)\n",
    );
  }

  console.log(`📁 Repository: ${repo}\n`);

  // Fetch PR metadata
  console.log("📡 Fetching PR metadata...");
  const prs = [];

  for (const prNumber of prNumbers) {
    try {
      console.log(`  Fetching PR #${prNumber}...`);
      const pr = await fetchPRMetadata(repo, prNumber, token);
      prs.push({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        url: `https://github.com/${repo}/pull/${pr.number}`,
      });
    } catch (error) {
      if (error.message.includes("404")) {
        console.warn(`  ⚠️  PR #${prNumber} not found in ${repo} (404)`);
      } else if (error.message.includes("403")) {
        console.error(
          `  ❌ Failed to fetch PR #${prNumber}: ${error.message}`,
        );
        console.error(
          "      This is a private repository - make sure GITHUB_TOKEN or GH_TOKEN is set",
        );
      } else if (error.message.includes("401")) {
        console.error(
          `  ❌ Failed to fetch PR #${prNumber}: ${error.message}`,
        );
        console.error("      Your GitHub token is invalid or expired");
      } else {
        console.error(
          `  ❌ Failed to process PR #${prNumber}: ${error.message}`,
        );
      }
      console.error("      Skipping...");
    }
  }

  console.log(`\n✅ Successfully fetched ${prs.length} PRs\n`);

  const result = {
    packageName,
    baseRef,
    baseVersion: resolvedBaseVersion,
    version,
    prs,
  };

  // When called directly from CLI, generate basic changelog
  if (!dryRun && require.main === module) {
    if (prs.length > 0) {
      const repoRoot = getRepoRoot();
      const changelogDir = path.join(repoRoot, packagePath, "changelog", version);
      if (!fs.existsSync(changelogDir)) {
        fs.mkdirSync(changelogDir, { recursive: true });
      }

      const changelog = generateBasicChangelog(version, prs);
      fs.writeFileSync(path.join(changelogDir, "CHANGELOG.md"), changelog);
      console.log(`✅ Generated ${changelogDir}/CHANGELOG.md`);
    } else {
      console.log("No valid PRs to generate changelog");
    }
  }

  return result;
}

/**
 * CLI entry point
 */
async function main() {
  const params = parseArgs(process.argv.slice(2));

  if (!params.package) {
    console.error("Usage:");
    console.error(
      "  node scripts/generate-changelog-qvac.cjs --package=<name> [options]",
    );
    console.error("");
    console.error("Options:");
    console.error("  --package        Package name (e.g., sdk)");
    console.error(
      "  --base-commit    Initial commit SHA (overrides tag lookup)",
    );
    console.error("  --base-version   Version label for base commit");
    console.error("  --release-type   minor or patch (auto-detected from package.json version)");
    console.error("  --dry-run        Show output without writing files");
    process.exit(1);
  }

  console.log("🚀 Generating changelog...\n");

  try {
    const result = await generateChangelog({
      packageName: params.package,
      baseCommit: params["base-commit"] || undefined,
      baseVersion: params["base-version"] || undefined,
      releaseType: params["release-type"] || undefined,
      dryRun: params["dry-run"] !== undefined,
    });

    if (params["dry-run"]) {
      console.log("\n📋 Dry run result:");
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("\n🎉 Changelog generation complete!");
    }
  } catch (error) {
    console.error(`\n❌ ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n❌ ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  generateChangelog,
  getLatestTag,
  extractVersionFromTag,
  detectReleaseType,
  resolveBaseRef,
  getPRNumbers,
  fetchPRMetadata,
  getGitHubToken,
  getRepoRoot,
  getRepoFromRemote,
  getPackageVersion,
  generateBasicChangelog,
  parseArgs,
  git,
};
