#!/usr/bin/env node

/**
 * Script to check broken links using Fumadocs native API
 * 
 * This script:
 * 1. Uses source.getPages() to discover all pages
 * 2. Uses source.getPage() to validate links
 * 3. Uses data.toc to validate anchors
 * 4. Uses customTree to validate navigation structure
 * 5. Reports broken links with exact location
 * 
 * Usage: npm run check-links
 */

const { glob } = require('glob');
const fs = require('fs');
const path = require('path');

async function checkBrokenLinksWithFumadocs() {
  console.log('🔍 Checking broken links using Fumadocs native API...\n');
  
  try {
    // 1. Use Fumadocs API via Next.js execution
    const { execSync } = require('child_process');
    
    // Execute a script that uses Fumadocs API
    const fumadocsScript = `
      const { source } = require('./src/lib/source.ts');
      const { customTree } = require('./src/lib/custom-tree.ts');
      
      const allPages = source.getPages();
      const validUrls = new Set();
      const validAnchors = new Map();
      
      // Build map of valid URLs and anchors
      for (const page of allPages) {
        validUrls.add(page.url);
        
        if (page.data.toc) {
          const anchors = new Set();
          for (const item of page.data.toc) {
            if (item.url.startsWith('#')) {
              anchors.add(item.url.slice(1));
            }
          }
          validAnchors.set(page.url, anchors);
        }
      }
      
      // Add URLs from customTree
      function extractUrlsFromTree(nodes) {
        for (const node of nodes) {
          if (node.url) validUrls.add(node.url);
          if (node.children) extractUrlsFromTree(node.children);
          if (node.index && node.index.url) validUrls.add(node.index.url);
        }
      }
      extractUrlsFromTree(customTree);
      
      console.log(JSON.stringify({
        pageCount: allPages.length,
        validUrls: Array.from(validUrls),
        validAnchors: Object.fromEntries(validAnchors)
      }));
    `;
    
    // Write temporary script
    const tempScriptPath = path.join(process.cwd(), 'temp-fumadocs-check.js');
    fs.writeFileSync(tempScriptPath, fumadocsScript);
    
    // Execute via tsx (if available) or fallback to manual parsing
    let fumadocsData;
    try {
      const result = execSync('npx tsx temp-fumadocs-check.js', { 
        encoding: 'utf8',
        cwd: process.cwd(),
        stdio: 'pipe' // Capture stderr to prevent error output
      });
      fumadocsData = JSON.parse(result.trim());
      console.log(`📊 Discovering ${fumadocsData.pageCount} pages via Fumadocs...`);
    } catch (error) {
      // Silently fallback to manual parsing without showing the tsx error
      console.log('⚠️  Using manual parsing of custom-tree...');
      fumadocsData = await getFumadocsDataManually();
    } finally {
      // Clean up temporary file
      if (fs.existsSync(tempScriptPath)) {
        fs.unlinkSync(tempScriptPath);
      }
    }
    
    const validUrls = new Set(fumadocsData.validUrls);
    const validAnchors = new Map(Object.entries(fumadocsData.validAnchors));
    
    console.log(`📊 Total of ${validUrls.size} valid URLs discovered`);
    console.log(`📊 Total of ${validAnchors.size} pages with anchors discovered\n`);
    
    // 4. Check links in all MDX files
    const contentPath = path.join(process.cwd(), 'content/docs');
    const files = await glob('**/*.mdx', { cwd: contentPath });
    
    const brokenLinks = [];
    
    for (const file of files) {
      const filePath = path.join(contentPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const links = extractLinksFromMDX(content, file);
      
      for (const link of links) {
        if (isInternalLink(link.url)) {
          const { url, anchor } = parseLink(link.url);
          
          // Check if base URL exists
          if (!validUrls.has(url)) {
            brokenLinks.push({
              source: file,
              link: link.url,
              text: link.text,
              line: link.line,
              reason: 'URL not found'
            });
            continue;
          }
          
          // Check if anchor exists (if present)
          if (anchor) {
            const pageAnchors = validAnchors.get(url);
            if (!pageAnchors || !pageAnchors.includes(anchor)) {
              brokenLinks.push({
                source: file,
                link: link.url,
                text: link.text,
                line: link.line,
                reason: `Anchor '#${anchor}' not found on page`
              });
            }
          }
        }
      }
    }
    
    // 5. Report
    if (brokenLinks.length === 0) {
      console.log('✅ No broken links found!');
    } else {
      console.log(`❌ ${brokenLinks.length} broken links found:\n`);
      
      brokenLinks.forEach(link => {
        console.log(`📄 ${link.source}:${link.line}`);
        console.log(`   Link: [${link.text}](${link.link})`);
        console.log(`   Reason: ${link.reason}`);
        console.log('');
      });
    }
    
    return brokenLinks.length;
    
  } catch (error) {
    console.error('Error using Fumadocs native API:', error.message);
    console.error('Stack:', error.stack);
    return 1;
  }
}

function extractLinksFromMDX(content, filePath) {
  const links = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  
  while ((match = linkRegex.exec(content)) !== null) {
    const [, text, url] = match;
    const line = content.substring(0, match.index).split('\n').length;
    
    links.push({ text, url, line });
  }
  
  return links;
}

function isInternalLink(url) {
  return url.startsWith('/') && !url.startsWith('http');
}

function parseLink(url) {
  const [baseUrl, anchor] = url.split('#');
  return {
    url: baseUrl,
    anchor: anchor || null
  };
}

async function getFumadocsDataManually() {
  // Fallback: manual parsing of custom-tree.ts
  const customTreePath = path.join(process.cwd(), 'src/lib/custom-tree.ts');
  const customTreeContent = fs.readFileSync(customTreePath, 'utf8');
  
  const validUrls = new Set();
  const urlRegex = /url:\s*['"`]([^'"`]+)['"`]/g;
  let match;
  
  while ((match = urlRegex.exec(customTreeContent)) !== null) {
    validUrls.add(match[1]);
  }
  
  // Discover pages via .mdx files and extract anchors
  const contentPath = path.join(process.cwd(), 'content/docs');
  const files = await glob('**/*.mdx', { cwd: contentPath });
  const validAnchors = {};
  
  for (const file of files) {
    const relativePath = file.replace(/\.mdx$/, '');
    const url = `/${relativePath}`;
    validUrls.add(url);
    
    // Extract anchors from MDX file
    const filePath = path.join(contentPath, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const anchors = extractAnchorsFromMDX(content);
    if (anchors.length > 0) {
      validAnchors[url] = anchors;
      
      // Also map version without /index for index pages
      if (relativePath.endsWith('/index')) {
        const urlWithoutIndex = url.replace('/index', '');
        validAnchors[urlWithoutIndex] = anchors;
      }
    }
  }
  
  return {
    pageCount: files.length,
    validUrls: Array.from(validUrls),
    validAnchors: validAnchors
  };
}

function extractAnchorsFromMDX(content) {
  const anchors = [];
  // Extract headings (##, ###, etc.) and convert to anchors
  const headingRegex = /^#{2,6}\s+(.+)$/gm;
  let match;
  
  while ((match = headingRegex.exec(content)) !== null) {
    const heading = match[1];
    // Convert to anchor: remove special characters, convert to lowercase, replace spaces with hyphens
    const anchor = heading
      .toLowerCase()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Remove duplicate hyphens
      .replace(/^-|-$/g, ''); // Remove leading and trailing hyphens
    
    if (anchor) {
      anchors.push(anchor);
    }
  }
  
  return anchors;
}

// Execute if called directly
if (require.main === module) {
  checkBrokenLinksWithFumadocs()
    .then(exitCode => process.exit(exitCode))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

module.exports = { checkBrokenLinksWithFumadocs };
