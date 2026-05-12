#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

function parseArgs (argv) {
  const args = {
    title: 'Performance Report',
    output: '',
    outputHtml: '',
    sections: []
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--title' && next) {
      args.title = next
      i++
    } else if (arg === '--output' && next) {
      args.output = next
      i++
    } else if (arg === '--output-html' && next) {
      args.outputHtml = next
      i++
    } else if (arg === '--section' && next) {
      args.sections.push(parseSection(next))
      i++
    }
  }

  if (!args.outputHtml) {
    throw new Error('Missing required --output-html argument')
  }

  return args
}

function parseSection (value) {
  const separator = value.indexOf('=')
  if (separator === -1) {
    throw new Error(`Invalid --section "${value}". Expected "Title=path".`)
  }

  return {
    title: value.slice(0, separator).trim(),
    file: value.slice(separator + 1).trim()
  }
}

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function ensureParentDir (filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function loadSection (section) {
  const exists = fs.existsSync(section.file) && fs.statSync(section.file).size > 0
  return {
    title: section.title,
    file: section.file,
    exists,
    html: exists ? fs.readFileSync(section.file, 'utf8') : '',
    size: exists ? fs.statSync(section.file).size : 0
  }
}

function renderMarkdown (title, sections) {
  const lines = [
    `# ${title}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    ''
  ]

  for (const section of sections) {
    const status = section.exists ? `included (${section.size} bytes)` : 'missing'
    lines.push(`- ${section.title}: ${status}`)
  }

  lines.push('')
  return lines.join('\n')
}

function renderHtml (title, sections) {
  const renderedSections = sections.map(section => {
    if (!section.exists) {
      return `<section class="report-section missing">
        <h2>${escapeHtml(section.title)}</h2>
        <p>No HTML report was available at <code>${escapeHtml(section.file)}</code>.</p>
      </section>`
    }

    return `<section class="report-section">
      <div class="section-header">
        <h2>${escapeHtml(section.title)}</h2>
        <span>${escapeHtml(section.file)}</span>
      </div>
      <iframe title="${escapeHtml(section.title)}" srcdoc="${escapeHtml(section.html)}"></iframe>
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #f6f8fa;
    --card: #ffffff;
    --border: #d0d7de;
    --text: #24292f;
    --muted: #57606a;
    --accent: #0969da;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    max-width: 1600px;
    margin: 0 auto 24px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 28px;
  }
  .meta {
    color: var(--muted);
    font-size: 14px;
  }
  .report-section {
    max-width: 1600px;
    margin: 0 auto 24px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(27, 31, 36, 0.05);
  }
  .section-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .section-header h2 {
    margin: 0 0 4px;
    font-size: 20px;
  }
  .section-header span {
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
  }
  iframe {
    display: block;
    width: 100%;
    height: 900px;
    border: 0;
    background: white;
  }
  .missing {
    padding: 20px;
    border-color: #f0b429;
  }
  .missing h2 {
    margin-top: 0;
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Generated ${escapeHtml(new Date().toISOString())}</div>
</header>
${renderedSections}
</body>
</html>
`
}

function main () {
  const args = parseArgs(process.argv)
  const sections = args.sections.map(loadSection)
  const html = renderHtml(args.title, sections)

  ensureParentDir(args.outputHtml)
  fs.writeFileSync(args.outputHtml, html)

  if (args.output) {
    ensureParentDir(args.output)
    fs.writeFileSync(args.output, renderMarkdown(args.title, sections))
  }
}

main()
