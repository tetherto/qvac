#!/usr/bin/env node

/**
 * Changelog generator script
 *
 * Generates changelog from merged PRs between dev and main branches
 *
 * Usage:
 *   node scripts/changelog-generate.cjs
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { validatePR } = require("./validator.cjs");

const REPO = "tetherto/qvac-sdk";

const PREFIX_EMOJIS = {
  feat: "✨",
  fix: "🐞",
  doc: "📘",
  test: "🧪",
  chore: "🧹",
  infra: "⚙️",
};

const TAG_EMOJIS = {
  api: "🔌",
  bc: "💥",
  mod: "📦",
};

/**
 * Get GitHub API token from environment or GitHub CLI
 * @returns {string|null}
 */
function getGitHubToken() {
  // First, try environment variables
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    return envToken;
  }

  // Try to get token from GitHub CLI if installed
  try {
    const ghToken = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"], // Suppress stderr
    }).trim();

    if (ghToken && ghToken.length > 0) {
      console.log("ℹ️  Using GitHub CLI (gh) authentication\n");
      return ghToken;
    }
  } catch (error) {
    // gh CLI not installed or not authenticated, that's fine
  }

  return null;
}

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
 * Get package.json version for a branch
 * @param {string} branch
 * @returns {string}
 */
function getPackageVersion(branch) {
  try {
    const content = git(`show ${branch}:package.json`);
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch (error) {
    console.error(`Failed to get version from ${branch}`);
    throw error;
  }
}

/**
 * Get package.json version from local working directory
 * @returns {string}
 */
function getLocalPackageVersion() {
  try {
    const content = fs.readFileSync(
      path.join(process.cwd(), "package.json"),
      "utf8",
    );
    const pkg = JSON.parse(content);
    return pkg.version;
  } catch (error) {
    console.error("Failed to get version from local package.json");
    throw error;
  }
}

/**
 * Compare two semver versions
 * @param {string} v1
 * @param {string} v2
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }

  return 0;
}

/**
 * Get PR numbers from merge commits
 * @param {string} devBranch
 * @param {string} mainBranch
 * @returns {number[]}
 */
function getPRNumbers(devBranch, mainBranch) {
  try {
    // Get commits in dev that are not in main
    const commits = git(`log ${mainBranch}..${devBranch} --oneline --merges`);

    if (!commits) {
      console.log("No merge commits found");
      return [];
    }

    const prNumbers = [];
    const lines = commits.split("\n");

    for (const line of lines) {
      // Match "Merge pull request #123" or "#123" patterns
      const match = line.match(/#(\d+)/);
      if (match) {
        prNumbers.push(parseInt(match[1], 10));
      }
    }

    // Remove duplicates and sort
    return [...new Set(prNumbers)].sort((a, b) => a - b);
  } catch (error) {
    console.error("Failed to get PR numbers");
    throw error;
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
    // Support both "token" and "Bearer" prefix for GitHub tokens
    headers["Authorization"] = token.startsWith("ghp_")
      ? `Bearer ${token}`
      : `token ${token}`;
  }

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      let errorDetails = `${response.status}: ${response.statusText}`;

      // Provide helpful error messages
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
  } catch (error) {
    throw error;
  }
}

/**
 * Extract code blocks from markdown
 * @param {string} text
 * @returns {string[]}
 */
function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```[\s\S]*?```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[0]);
  }

  return blocks;
}

/**
 * Extract BEFORE/AFTER examples from text
 * @param {string} text
 * @returns {string|null}
 */
function extractBeforeAfter(text) {
  // Try BEFORE:/AFTER: pattern first
  const beforeAfterMatch = text.match(
    /BEFORE:\s*([\s\S]*?)\s*AFTER:\s*([\s\S]*?)(?=\n\n|$)/i,
  );
  if (beforeAfterMatch) {
    return `**BEFORE:**\n${beforeAfterMatch[1].trim()}\n\n**AFTER:**\n${beforeAfterMatch[2].trim()}`;
  }

  // Try to find code blocks with // old and // new
  const codeBlocks = extractCodeBlocks(text);
  for (const block of codeBlocks) {
    if (block.includes("// old") && block.includes("// new")) {
      return block;
    }
  }

  return null;
}

/**
 * Extract model names from a code block content
 * @param {string} codeBlock - The code block including backticks
 * @returns {string[]}
 */
function extractModelNames(codeBlock) {
  // Remove the backticks and any language identifier
  const content = codeBlock.replace(/```\w*\n?/g, "").replace(/```/g, "");

  // Split by newlines and filter out empty lines and "(none)" markers
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line.toLowerCase() !== "(none)" &&
        line.toLowerCase() !== "none" &&
        !line.startsWith("//") &&
        !line.startsWith("#"),
    );
}

/**
 * Extract models section from PR body
 * @param {string} body - The PR body
 * @returns {{ added: string[], removed: string[] } | null}
 */
function extractModelsSection(body) {
  if (!body) return null;

  // Check for Models section
  const modelsSectionMatch = body.match(
    /##\s*(?:📦\s*)?Models\s*\n([\s\S]*?)(?=\n##\s|$)/i,
  );
  if (!modelsSectionMatch) return null;

  const modelsSection = modelsSectionMatch[1];

  // Extract Added models subsection
  const addedMatch = modelsSection.match(
    /###\s*Added\s*(?:models)?\s*\n[\s\S]*?(```[\s\S]*?```)/i,
  );

  // Extract Removed models subsection
  const removedMatch = modelsSection.match(
    /###\s*Removed\s*(?:models)?\s*\n[\s\S]*?(```[\s\S]*?```)/i,
  );

  const added = addedMatch ? extractModelNames(addedMatch[1]) : [];
  const removed = removedMatch ? extractModelNames(removedMatch[1]) : [];

  return { added, removed };
}

/**
 * Capitalize first letter of string
 * @param {string} str
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generate changelog entry
 * @param {object} pr - PR metadata with parsed title
 * @param {boolean} hasBreakingMd - Whether breaking.md exists
 * @param {boolean} hasApiMd - Whether api.md exists
 * @param {boolean} hasModelsMd - Whether models.md exists
 * @returns {string}
 */
function generateChangelogEntry(
  pr,
  hasBreakingMd = false,
  hasApiMd = false,
  hasModelsMd = false,
) {
  const { parsed } = pr;
  const subject = capitalize(parsed.subject);

  let entry = `- ${subject}. (see PR [#${pr.number}](${pr.url}))`;

  // Add links to detail files if applicable
  const links = [];
  if (parsed.tags.includes("bc") && hasBreakingMd) {
    links.push("[breaking changes](./breaking.md)");
  }
  if (parsed.tags.includes("api") && hasApiMd) {
    links.push("[API changes](./api.md)");
  }
  if (parsed.tags.includes("mod") && hasModelsMd) {
    links.push("[model changes](./models.md)");
  }

  if (links.length > 0) {
    entry += ` - See ${links.join(", ")}`;
  }

  return entry;
}

/**
 * Generate changelog files
 * @param {string} version
 * @param {Array} prs - Array of PR objects with metadata and parsed titles
 */
function generateChangelogFiles(version, prs) {
  const changelogDir = path.join(process.cwd(), "changelog", version);

  // Create changelog directory
  if (!fs.existsSync(changelogDir)) {
    fs.mkdirSync(changelogDir, { recursive: true });
  }

  // Group PRs by classification
  const grouped = {};
  const breakingChanges = [];
  const apiChanges = [];
  const modelChanges = [];

  for (const pr of prs) {
    const { parsed } = pr;

    // Classify: PRs with [api] tag go to API section, PRs with [mod] tag go to models section
    let classification = parsed.prefix;
    if (parsed.tags.includes("api")) {
      classification = "api";
    }
    if (parsed.tags.includes("mod")) {
      classification = "mod";
    }

    if (!grouped[classification]) {
      grouped[classification] = [];
    }
    grouped[classification].push(pr);

    // Track PRs for detail files
    if (parsed.tags.includes("bc")) {
      breakingChanges.push(pr);
    }
    if (parsed.tags.includes("api")) {
      apiChanges.push(pr);
    }
    if (parsed.tags.includes("mod")) {
      modelChanges.push(pr);
    }
  }

  // Check if we'll generate detail files
  const hasBreakingMd = breakingChanges.length > 0;
  const hasApiMd = apiChanges.length > 0;
  const hasModelsMd = modelChanges.length > 0;

  // Generate main CHANGELOG.md
  let changelog = `# Changelog v${version}\n\n`;
  changelog += `Release Date: ${new Date().toISOString().split("T")[0]}\n\n`;

  // Add sections in order: Features, API, Fixes, then the rest
  const sections = [
    { key: "feat", title: "✨ Features" },
    { key: "api", title: "🔌 API" },
    { key: "fix", title: "🐞 Fixes" },
    { key: "mod", title: "📦 Models" },
    { key: "doc", title: "📘 Docs" },
    { key: "test", title: "🧪 Tests" },
    { key: "chore", title: "🧹 Chores" },
    { key: "infra", title: "⚙️ Infrastructure" },
  ];

  for (const section of sections) {
    if (grouped[section.key] && grouped[section.key].length > 0) {
      changelog += `## ${section.title}\n\n`;
      for (const pr of grouped[section.key]) {
        changelog +=
          generateChangelogEntry(pr, hasBreakingMd, hasApiMd, hasModelsMd) +
          "\n";
      }
      changelog += "\n";
    }
  }

  fs.writeFileSync(path.join(changelogDir, "CHANGELOG.md"), changelog);
  console.log(`✅ Generated ${changelogDir}/CHANGELOG.md`);

  // Generate breaking.md if there are breaking changes
  if (breakingChanges.length > 0) {
    let breakingMd = `# 💥 Breaking Changes v${version}\n\n`;

    for (const pr of breakingChanges) {
      const subject = capitalize(pr.parsed.subject);
      breakingMd += `## ${subject}\n\n`;
      breakingMd += `PR: [#${pr.number}](${pr.url})\n\n`;

      const beforeAfter = extractBeforeAfter(pr.body);
      if (beforeAfter) {
        breakingMd += beforeAfter + "\n\n";
      } else {
        breakingMd += "_No code examples provided_\n\n";
      }

      breakingMd += "---\n\n";
    }

    fs.writeFileSync(path.join(changelogDir, "breaking.md"), breakingMd);
    console.log(`✅ Generated ${changelogDir}/breaking.md`);
  }

  // Generate api.md if there are API changes
  if (apiChanges.length > 0) {
    let apiMd = `# 🔌 API Changes v${version}\n\n`;

    for (const pr of apiChanges) {
      const subject = capitalize(pr.parsed.subject);
      apiMd += `## ${subject}\n\n`;
      apiMd += `PR: [#${pr.number}](${pr.url})\n\n`;

      const codeBlocks = extractCodeBlocks(pr.body);
      if (codeBlocks.length > 0) {
        apiMd += codeBlocks.join("\n\n") + "\n\n";
      } else {
        apiMd += "_No code examples provided_\n\n";
      }

      apiMd += "---\n\n";
    }

    fs.writeFileSync(path.join(changelogDir, "api.md"), apiMd);
    console.log(`✅ Generated ${changelogDir}/api.md`);
  }

  // Generate models.md if there are model changes
  if (modelChanges.length > 0) {
    // Aggregate model changes across all PRs
    const allAdded = new Set();
    const allRemoved = new Set();

    for (const pr of modelChanges) {
      const models = extractModelsSection(pr.body);
      if (models) {
        models.added.forEach((m) => allAdded.add(m));
        models.removed.forEach((m) => allRemoved.add(m));
      }
    }

    // Cancel out: if a model is both added and removed, remove from both sets
    for (const model of allAdded) {
      if (allRemoved.has(model)) {
        allAdded.delete(model);
        allRemoved.delete(model);
      }
    }

    // Sort alphabetically
    const addedList = [...allAdded].sort();
    const removedList = [...allRemoved].sort();

    let modelsMd = `# 📦 Model Changes v${version}\n\n`;

    if (addedList.length > 0) {
      modelsMd += `## Added Models\n\n`;
      modelsMd += "```\n";
      modelsMd += addedList.join("\n") + "\n";
      modelsMd += "```\n\n";
    }

    if (removedList.length > 0) {
      modelsMd += `## Removed Models\n\n`;
      modelsMd += "```\n";
      modelsMd += removedList.join("\n") + "\n";
      modelsMd += "```\n\n";
    }

    if (addedList.length === 0 && removedList.length === 0) {
      modelsMd += "_No net model changes in this release._\n";
    }

    // Add PR references
    modelsMd += `---\n\n`;
    modelsMd += `### Related PRs\n\n`;
    for (const pr of modelChanges) {
      modelsMd += `- [#${pr.number}](${pr.url}) - ${capitalize(pr.parsed.subject)}\n`;
    }

    fs.writeFileSync(path.join(changelogDir, "models.md"), modelsMd);
    console.log(`✅ Generated ${changelogDir}/models.md`);
  }
}

/**
 * Main function
 */
async function main() {
  console.log("🚀 Generating changelog...\n");

  try {
    // Check we're in a git repository
    git("rev-parse --git-dir");
  } catch (error) {
    console.error("❌ Not a git repository");
    process.exit(1);
  }

  const mainBranch = "origin/main";

  // Fetch latest changes from main (to compare against)
  console.log("📥 Fetching latest main...");
  try {
    git("fetch origin main");
  } catch (error) {
    console.error("❌ Failed to fetch main branch");
    process.exit(1);
  }

  // Get versions - local dev vs remote main
  console.log("📦 Checking versions...");
  const devVersion = getLocalPackageVersion();
  const mainVersion = getPackageVersion(mainBranch);

  console.log(`  Local version: ${devVersion}`);
  console.log(`  Main version: ${mainVersion}`);

  if (compareVersions(devVersion, mainVersion) <= 0) {
    console.error(
      `❌ Local version (${devVersion}) must be greater than main version (${mainVersion})`,
    );
    process.exit(1);
  }

  console.log("✅ Version check passed\n");

  // Get PR numbers (compare HEAD against origin/main)
  console.log("🔍 Finding merged PRs...");
  const prNumbers = getPRNumbers("HEAD", mainBranch);

  if (prNumbers.length === 0) {
    console.log("No PRs found to generate changelog");
    process.exit(0);
  }

  console.log(`  Found ${prNumbers.length} PRs: ${prNumbers.join(", ")}\n`);

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
  } else if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    // Token was found via gh CLI
    console.log("✅ Using GitHub CLI authentication\n");
  } else {
    console.log("✅ GitHub token found\n");
  }

  console.log(`📁 Repository: ${REPO}\n`);

  // Fetch PR metadata
  console.log("📡 Fetching PR metadata...");
  const prs = [];

  for (const prNumber of prNumbers) {
    try {
      console.log(`  Fetching PR #${prNumber}...`);
      const pr = await fetchPRMetadata(REPO, prNumber, token);

      // Validate and parse PR title
      const validation = validatePR(pr.title, pr.body);

      if (!validation.valid) {
        console.warn(
          `  ⚠️  PR #${prNumber} has invalid format: ${validation.error}`,
        );
        console.warn(`      Skipping...`);
        continue;
      }

      // Skip PRs with [skiplog] tag
      if (validation.parsed.tags.includes("skiplog")) {
        console.log(
          `  ⏭️  PR #${prNumber} has [skiplog] tag, excluding from changelog`,
        );
        continue;
      }

      prs.push({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        url: `https://github.com/${REPO}/pull/${pr.number}`,
        parsed: validation.parsed,
      });
    } catch (error) {
      // More graceful error handling - just skip PRs that can't be fetched
      if (error.message.includes("404")) {
        console.warn(`  ⚠️  PR #${prNumber} not found in ${REPO} (404)`);
        console.warn(`      Skipping...`);
      } else if (error.message.includes("403")) {
        console.error(`  ❌ Failed to fetch PR #${prNumber}: ${error.message}`);
        console.error(
          "      This is a private repository - make sure GITHUB_TOKEN or GH_TOKEN is set",
        );
        console.error(
          "      Token needs 'repo' scope. Create at: https://github.com/settings/tokens",
        );
        console.error("      Skipping...");
      } else if (error.message.includes("401")) {
        console.error(`  ❌ Failed to fetch PR #${prNumber}: ${error.message}`);
        console.error("      Your GitHub token is invalid or expired");
        console.error("      Skipping...");
      } else {
        console.error(
          `  ❌ Failed to process PR #${prNumber}: ${error.message}`,
        );
        console.error("      Skipping...");
      }
    }
  }

  console.log(`\n✅ Successfully processed ${prs.length} PRs\n`);

  if (prs.length === 0) {
    console.log("No valid PRs to generate changelog");
    process.exit(0);
  }

  // Generate changelog files
  console.log("📝 Generating changelog files...");
  generateChangelogFiles(devVersion, prs);

  console.log("\n🎉 Changelog generation complete!");
  console.log(`\nGenerated files in: changelog/${devVersion}/`);
}

// Run main function
if (require.main === module) {
  main().catch((error) => {
    throw error;
  });
}

module.exports = {
  generateChangelogFiles,
  getPRNumbers,
  fetchPRMetadata,
};
