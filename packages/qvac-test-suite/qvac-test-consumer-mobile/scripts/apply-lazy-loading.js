#!/usr/bin/env node

/**
 * Dynamic SDK Lazy-Loading Patcher
 * 
 * Converts static imports of heavy native modules to dynamic imports.
 * Works across SDK versions by detecting patterns rather than patching specific lines.
 */

const fs = require('fs');
const path = require('path');

const SDK_PATH = path.join(__dirname, '..', 'node_modules', '@tetherto', 'sdk-dev', 'dist', 'server', 'bare', 'addons');

// Define modules to lazy-load and their patterns
const LAZY_LOAD_CONFIGS = [
    {
        name: 'llamacpp',
        file: 'llamacpp/create-model.js',
        imports: [
            { module: '@qvac/llm-llamacpp', varName: 'LlmLlamacpp' },
            { module: '@qvac/embed-llamacpp', varName: 'EmbedLlamacpp' }
        ],
        functions: ['createLlmModel', 'createEmbeddingsModel']
    },
    {
        name: 'whispercpp',
        file: 'whispercpp/create-model.js',
        imports: [
            { module: '@qvac/transcription-whispercpp', varName: 'TranscriptionWhispercpp' }
        ],
        functions: ['createWhisperModel']
    },
    {
        name: 'translation',
        file: 'translation/create-model.js',
        imports: [
            { module: '@qvac/translation-nmtcpp', varName: 'TranslationNmtcpp' }
        ],
        functions: ['createNmtModel']
    },
    {
        name: 'tts',
        file: 'tts/create-model.js',
        imports: [
            { module: '@qvac/tts-onnx', varName: 'ONNXTTS' }
        ],
        functions: ['createTtsModel']
    }
];

/**
 * Converts static import to lazy-loading pattern
 */
function convertToLazyLoad(content, config) {
    let modified = content;
    let hasChanges = false;

    for (const imp of config.imports) {
        // Check if static import exists
        const staticImportPattern = new RegExp(
            `import\\s+${imp.varName}\\s+from\\s+["']${imp.module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'];?`,
            'g'
        );

        if (!staticImportPattern.test(modified)) {
            continue; // Already converted or doesn't exist
        }

        hasChanges = true;

        // Remove static import
        modified = modified.replace(staticImportPattern, '');

        // Create getter function name
        const getterName = `get${imp.varName}`;

        // Find a good place to insert lazy loader (after other imports, before first function)
        const insertPattern = /^(import.*\n)+/m;
        const match = modified.match(insertPattern);

        let insertPos;
        if (match) {
            insertPos = match.index + match[0].length;
        } else {
            // Fallback: insert at beginning
            insertPos = 0;
        }

        // Create lazy-loading code
        const lazyLoadCode = `
let ${imp.varName} = null;
async function ${getterName}() {
    if (!${imp.varName}) {
        const mod = await import("${imp.module}");
        ${imp.varName} = mod.default;
    }
    return ${imp.varName};
}
`;

        // Insert lazy loader
        modified = modified.slice(0, insertPos) + lazyLoadCode + modified.slice(insertPos);

        // Track which functions use this class
        const classUsagePattern = new RegExp(`new\\s+${imp.varName}\\s*\\(`, 'g');
        const staticAccessPattern = new RegExp(`${imp.varName}\\.`, 'g');

        const usesClass = classUsagePattern.test(modified) || staticAccessPattern.test(modified);

        if (!usesClass) {
            continue; // This class isn't used, skip
        }

        // Update each function that uses this class
        for (const funcName of config.functions) {
            // Extract the function body to check if it uses this specific class
            const funcRegex = new RegExp(
                `(export\\s+(?:async\\s+)?function\\s+${funcName}\\s*\\([^)]*\\)\\s*{)([\\s\\S]*?)(?=\\nexport|\\n$)`,
                'm'
            );

            const funcMatch = modified.match(funcRegex);
            if (!funcMatch) continue;

            const funcBody = funcMatch[2];
            const funcUsesClass = new RegExp(`\\b${imp.varName}\\b`).test(funcBody);

            if (!funcUsesClass) continue;

            // Make function async if not already
            const makeAsyncPattern = new RegExp(`(export\\s+)function(\\s+${funcName})`, 'g');
            modified = modified.replace(makeAsyncPattern, '$1async function$2');

            // Add class getter at the start of the function
            const funcStartPattern = new RegExp(
                `(export\\s+async\\s+function\\s+${funcName}\\s*\\([^)]*\\)\\s*{)`,
                'g'
            );
            modified = modified.replace(funcStartPattern, `$1\n    const ${imp.varName}Class = await ${getterName}();`);

            // Replace new ClassName( with new ClassNameClass( only in this function
            const replacements = [];
            let match;
            const newClassPattern = new RegExp(`new\\s+${imp.varName}\\s*\\(`, 'g');
            while ((match = newClassPattern.exec(modified)) !== null) {
                replacements.push({ index: match.index, text: match[0] });
            }

            for (let i = replacements.length - 1; i >= 0; i--) {
                const repl = replacements[i];
                modified = modified.slice(0, repl.index) +
                    repl.text.replace(imp.varName, `${imp.varName}Class`) +
                    modified.slice(repl.index + repl.text.length);
            }

            // Handle static property access (e.g., ClassName.ModelTypes)
            const staticReplacements = [];
            const staticPattern = new RegExp(`${imp.varName}\\.`, 'g');
            while ((match = staticPattern.exec(modified)) !== null) {
                staticReplacements.push({ index: match.index, text: match[0] });
            }

            for (let i = staticReplacements.length - 1; i >= 0; i--) {
                const repl = staticReplacements[i];
                modified = modified.slice(0, repl.index) +
                    `${imp.varName}Class.` +
                    modified.slice(repl.index + repl.text.length);
            }
        }
    }

    return { modified, hasChanges };
}

/**
 * Updates load-model.js to await the create functions
 */
function updateLoadModel() {
    const loadModelPath = path.join(SDK_PATH, 'load-model.js');

    if (!fs.existsSync(loadModelPath)) {
        return false;
    }

    let content = fs.readFileSync(loadModelPath, 'utf8');
    let hasChanges = false;

    // Pattern: createXxxModel( -> await createXxxModel(
    const createFuncs = [
        'createLlmModel',
        'createEmbeddingsModel',
        'createWhisperModel',
        'createNmtModel',
        'createTtsModel'
    ];

    for (const funcName of createFuncs) {
        const pattern = new RegExp(`(\\s+result\\s*=\\s*)${funcName}\\(`, 'g');
        const replacement = `$1await ${funcName}(`;

        if (pattern.test(content)) {
            content = content.replace(pattern, replacement);
            hasChanges = true;
        }
    }

    if (hasChanges) {
        fs.writeFileSync(loadModelPath, content, 'utf8');
        console.log(`   ✓ Updated load-model.js to await create functions`);
    }

    return hasChanges;
}

/**
 * Main execution
 */
async function main() {
    console.log('🔄 Applying lazy-loading to SDK native modules...');

    if (!fs.existsSync(SDK_PATH)) {
        console.log('   ⊘ SDK addons path not found, skipping');
        return;
    }

    let totalPatched = 0;

    for (const config of LAZY_LOAD_CONFIGS) {
        const filePath = path.join(SDK_PATH, config.file);

        if (!fs.existsSync(filePath)) {
            console.log(`   ⊘ ${config.name}: file not found, skipping`);
            continue;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const { modified, hasChanges } = convertToLazyLoad(content, config);

        if (hasChanges) {
            fs.writeFileSync(filePath, modified, 'utf8');
            console.log(`   ✅ ${config.name}: converted to lazy-loading`);
            totalPatched++;
        } else {
            console.log(`   ✓ ${config.name}: already lazy-loaded or no changes needed`);
        }
    }

    // Update load-model.js
    if (updateLoadModel()) {
        totalPatched++;
    }

    if (totalPatched > 0) {
        console.log(`✅ Lazy-loading applied successfully (${totalPatched} files patched)`);
    } else {
        console.log('✅ All files already lazy-loaded');
    }
}

main().catch((err) => {
    console.error('❌ Lazy-loading error:', err);
    process.exit(1);
});

