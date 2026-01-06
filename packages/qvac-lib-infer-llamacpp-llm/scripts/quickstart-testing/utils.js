'use strict'

const { parse } = require('@babel/parser')
const traverse = require('@babel/traverse').default

function generateDeps (quickstartCode) {
  const ast = parse(quickstartCode, {
    sourceType: 'unambiguous', // handles both import and require
    plugins: ['jsx', 'dynamicImport']
  })

  const dependencies = new Set()

  traverse(ast, {
    ImportDeclaration ({ node }) {
      if (node.source?.value && !node.source.value.startsWith('.')) {
        dependencies.add(node.source.value)
      }
    },
    CallExpression ({ node }) {
      if (
        node.callee.name === 'require' &&
        node.arguments.length &&
        node.arguments[0].type === 'StringLiteral'
      ) {
        const dep = node.arguments[0].value
        if (!dep.startsWith('.')) {
          dependencies.add(dep)
        }
      }
    }
  })

  return dependencies
}

function generateQuickstartContent (
  quickstartCode,
  dependencies,
  quickstartSectionDescription,
  quickstartProjectName
) {
  let installInstructions = ''
  if (dependencies.size > 0) {
    installInstructions = `${quickstartSectionDescription}

### 0. Install Bare

\`\`\`bash
npm install -g bare
\`\`\`

### 1. Create a new Project

\`\`\`bash
mkdir ${quickstartProjectName}
cd ${quickstartProjectName}
npm init -y
\`\`\`

### 2. Install Dependencies

\`\`\`bash
npm install ${Array.from(dependencies).join(' ')}
\`\`\`

### 3. Copy Quickstart code into \`index.js\`
`
  }

  // Combine instructions + code snippet
  const combinedCode = `${installInstructions}\`\`\`js\n${quickstartCode.trim()}\n\`\`\`\n\n### 4. Run \`index.js\`\n\n\`\`\`bash\nbare index.js\n\`\`\`\n\n`

  return combinedCode
}

module.exports = { generateDeps, generateQuickstartContent }
