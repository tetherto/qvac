---
name: docx
description: Create, inspect, and convert Word documents (.docx), including PDF export workflows.
homepage: https://github.com/anthropics/skills/tree/main/skills/docx
---

# DOCX Workflow

Use this skill when the user asks to create, edit, analyze, or convert `.docx` files.

This skill is adapted from Anthropic's `docx` skill and focuses on practical CLI flows that work in this repo.

## Common Tasks

### 1) Create `.docx` from Markdown

```bash
pandoc input.md -o output.docx
```

### 2) Convert `.docx` to PDF

Prefer Pandoc when available:

```bash
pandoc input.docx -o output.pdf
```

LibreOffice fallback:

```bash
soffice --headless --convert-to pdf input.docx --outdir .
```

### 3) Read text content from `.docx`

```bash
pandoc input.docx -t markdown
```

### 4) Check tool availability first

```bash
which pandoc
which soffice
which libreoffice
```

## Authoring Tips

- Use Markdown as the source of truth, then convert.
- Keep headings consistent (`#`, `##`, `###`) for clean structure.
- Use explicit output paths and report the created files.
- If conversion fails, return exact stderr and suggest install commands.

## Install Hints

- Pandoc: `brew install pandoc`
- LibreOffice: `brew install --cask libreoffice`
