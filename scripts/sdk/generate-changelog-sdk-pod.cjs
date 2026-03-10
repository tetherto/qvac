#!/usr/bin/env node

/**
 * SDK pod changelog generator
 *
 * Wraps the qvac changelog script with SDK pod-specific
 * formatting: PR validation, emoji sections, breaking/api/model detail files.
 * Shared across all SDK pod packages.
 *
 * Usage:
 *   node scripts/sdk/generate-changelog-sdk-pod.cjs --package=sdk
 *   node scripts/sdk/generate-changelog-sdk-pod.cjs --package=rag --base-commit=abc123 --base-version=0.5.0
 */

const fs = require("fs");
const path = require("path");
const { validatePR } = require("./validator.cjs");
const {
  generateChangelog,
  getRepoRoot,
  parseArgs,
} = require("../generate-changelog-qvac.cjs");

const SECTIONS = [
  { key: "feat", title: "✨ Features" },
  { key: "api", title: "🔌 API" },
  { key: "fix", title: "🐞 Fixes" },
  { key: "mod", title: "📦 Models" },
  { key: "doc", title: "📘 Docs" },
  { key: "test", title: "🧪 Tests" },
  { key: "chore", title: "🧹 Chores" },
  { key: "infra", title: "⚙️ Infrastructure" },
];

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
 * @param {string} codeBlock
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
 * @param {string} body
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
 * @param {object} pr
 * @param {boolean} hasBreakingMd
 * @param {boolean} hasApiMd
 * @param {boolean} hasModelsMd
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
 * Generate SDK-specific changelog files
 * @param {string} version
 * @param {Array} prs - Array of PR objects with parsed titles
 * @param {string} [outputDir] - Override output directory (for testing)
 */
function generateChangelogFiles(packageName, version, prs, outputDir) {
  const changelogDir =
    outputDir || path.join(getRepoRoot(), "packages", packageName, "changelog", version);

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

  for (const section of SECTIONS) {
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

  // Generate breaking.md
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

  // Generate api.md
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

  // Generate models.md
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
 * Process raw PRs with SDK-specific validation and filtering
 * @param {Array<{number: number, title: string, body: string, url: string}>} rawPRs
 * @returns {Array} Validated PRs with parsed metadata
 */
function processSDKPRs(rawPRs) {
  const prs = [];

  for (const pr of rawPRs) {
    const validation = validatePR(pr.title, pr.body);

    if (!validation.valid) {
      console.warn(
        `  ⚠️  PR #${pr.number} has invalid format: ${validation.error}`,
      );
      console.warn(`      Skipping...`);
      continue;
    }

    if (validation.parsed.tags.includes("skiplog")) {
      console.log(
        `  ⏭️  PR #${pr.number} has [skiplog] tag, excluding from changelog`,
      );
      continue;
    }

    prs.push({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      url: pr.url,
      parsed: validation.parsed,
    });
  }

  return prs;
}

/**
 * Compare two semver strings (descending)
 * Example: 0.6.1 > 0.6.0 > 0.5.0
 */
function compareSemverDesc(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return -1;
    if (na < nb) return 1;
  }
  return 0;
}

/**
 * Rebuild root CHANGELOG.md from all version folders
 */
function rebuildRootChangelog(packageName) {
  const repoRoot = getRepoRoot();
  const pkgDir = path.join(repoRoot, "packages", packageName);
  const changelogRoot = path.join(pkgDir, "changelog");

  if (!fs.existsSync(changelogRoot)) {
    console.warn("⚠️ No changelog directory found.");
    return;
  }

  const versions = fs
    .readdirSync(changelogRoot)
    .filter((entry) => {
      const fullPath = path.join(changelogRoot, entry);
      return fs.statSync(fullPath).isDirectory();
    })
    // Only allow x.y.z format
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort(compareSemverDesc);

  if (versions.length === 0) {
    console.warn("⚠️ No version folders found.");
    return;
  }

  let combined = "";

  for (const version of versions) {
    let versionFile = path.join(changelogRoot, version, "CHANGELOG_LLM.md");

    if (!fs.existsSync(versionFile)) {
      versionFile = path.join(changelogRoot, version, "CHANGELOG.md");
    }

    if (!fs.existsSync(versionFile)) {
      console.warn(
        `⚠️ Skipping ${version} (no CHANGELOG_LLM.md or CHANGELOG.md)`
      );
      continue;
    }

    let content = fs.readFileSync(versionFile, "utf8").trim();
    // Transform version headers to "## [X.Y.Z]" for aggregated file
    content = content.replace(/^# Changelog v(\d+\.\d+\.\d+)/, "## [$1]");
    content = content.replace(/^# QVAC SDK v(\d+\.\d+\.\d+) Release Notes/, "## [$1]");
    // Rewrite relative links: ./file.md -> ./changelog/VERSION/file.md
    content = content.replace(
      /\(\.\/([^)]+\.md)\)/g,
      `(./changelog/${version}/$1)`
    );
    combined += content + "\n\n";
  }

  const rootFile = path.join(pkgDir, "CHANGELOG.md");
  const header = "# Changelog\n\n";

  fs.writeFileSync(rootFile, header + combined.trim() + "\n");

  console.log(
    `📚 Rebuilt root CHANGELOG.md with ${versions.length} versions`
  );
}

/**
 * Main function
 */
async function main() {
  const params = parseArgs(process.argv.slice(2));

  if ("update-root-changelog" in params) {
    if (!params.package) {
      console.error("--package is required with --update-root-changelog");
      process.exit(1);
    }

    rebuildRootChangelog(params.package);
    process.exit(0);
  }

  if (!params.package) {
    console.error("Usage:");
    console.error(
      "  node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<name> [options]",
    );
    console.error("");
    console.error("Options:");
    console.error("  --package        Package name (e.g., sdk)");
    console.error(
      "  --base-commit    Initial commit SHA (overrides tag lookup)",
    );
    console.error("  --base-version   Version label for base commit");
    console.error("  --update-root-changelog  Update root CHANGELOG.md");
    process.exit(1);
  }

  const packageName = params.package;

  console.log(`🚀 Generating SDK changelog for ${packageName}...\n`);

  try {
    // Get raw PR data from generic script
    const data = await generateChangelog({
      packageName,
      baseCommit: params["base-commit"] || undefined,
      baseVersion: params["base-version"] || undefined,
      dryRun: true, // Don't let generic script write files
    });

    if (data.prs.length === 0) {
      console.log("No PRs found to generate changelog");
      process.exit(0);
    }

    // Apply SDK-specific validation and filtering
    console.log("🔍 Validating PR formats...");
    const validPRs = processSDKPRs(data.prs);

    console.log(`\n✅ ${validPRs.length} valid PRs for changelog\n`);

    if (validPRs.length === 0) {
      console.log("No valid PRs to generate changelog");
      process.exit(0);
    }

    // Generate SDK-specific changelog files
    console.log("📝 Generating changelog files...");
    generateChangelogFiles(packageName, data.version, validPRs);
    rebuildRootChangelog(packageName);

    console.log("\n🎉 Changelog generation complete!");
    console.log(`\nGenerated files in: packages/${packageName}/changelog/${data.version}/`);
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
  extractCodeBlocks,
  extractBeforeAfter,
  extractModelNames,
  extractModelsSection,
  capitalize,
  generateChangelogEntry,
  generateChangelogFiles,
  processSDKPRs,
  SECTIONS,
};
