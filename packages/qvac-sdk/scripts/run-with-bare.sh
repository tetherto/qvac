#!/bin/bash

# run-with-bare.sh - Run examples with Bare runtime by injecting necessary globals and patches

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" || "$OSTYPE" == "cygwin" ]] || command -v cmd.exe >/dev/null 2>&1; then
    if ! command -v sed >/dev/null 2>&1 || ! command -v grep >/dev/null 2>&1; then
        # Simple Node.js fallback that calls this same script via bash if available
        exec node -e "
        const { spawn } = require('child_process');
        // Try to use bash to run this same script
        const result = spawn('bash', [process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' });
        result.on('error', () => {
            console.error('Error: This script requires bash with sed and grep tools.');
            console.error('Please install Git Bash, WSL, or MSYS2 on Windows.');
            process.exit(1);
        });
        result.on('close', (code) => process.exit(code));
        " "$0" "$@"
    fi
fi

if [ $# -eq 0 ]; then
    echo "Usage: $0 <path-to-js-file> [additional-args...]"
    echo "Example: $0 dist/examples/llamacpp-hyperdrive.js"
    exit 1
fi

INPUT_FILE="$1"
# Capture all remaining arguments after the first one
ADDITIONAL_ARGS=("${@:2}")

if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: File '$INPUT_FILE' not found"
    exit 1
fi

echo "🕚 Preparing '$INPUT_FILE' for Bare runtime..."
echo "🚀 Running with Bare runtime..."
echo ""

# Check if the file uses readline
USES_READLINE=$(grep -q "import.*readline\|require.*readline\|readline\." "$INPUT_FILE" && echo "true" || echo "false")

# Apply basic API patches to the file content
PATCHED_CONTENT=$(cat "$INPUT_FILE" | \
    sed 's/performance\.now()/Date.now()/g' | \
    sed 's/import { spawn } from "child_process"/import { spawn } from "bare-subprocess"/g' | \
    sed 's/import { spawnSync } from "child_process"/import { spawnSync } from "bare-subprocess"/g' | \
    sed 's|import { writeFileSync, unlinkSync } from "fs"|import { writeFileSync, unlinkSync } from "bare-fs"|g' | \
    sed 's/from "fs"/from "bare-fs"/g' | \
    sed 's/import fs from "fs"/import fs from "bare-fs"/g' | \
    sed 's/import { platform } from "os"/import { platform } from "bare-os"/g' | \
    sed 's/from "path"/from "bare-path"/g' | \
    sed 's/import path from "path"/import path from "bare-path"/g' | \
    sed 's/import os from "os"/import os from "bare-os"/g' | \
    sed 's/from "os"/from "bare-os"/g')

# Apply readline-specific patches only if readline is used
if [ "$USES_READLINE" = "true" ]; then
    echo "📝 Detected readline usage - applying input handling patches"
    PATCHED_CONTENT=$(echo "$PATCHED_CONTENT" | \
        sed 's/import readline from "readline"//g' | \
        sed 's/import \* as readline from "readline"//g' | \
        sed 's/from "readline"//g')
fi

# Create additional arguments array for injection (converting relative paths to absolute)
ORIGINAL_PWD="$(pwd)"
ADDITIONAL_ARGS_JSON="["
for arg in "${ADDITIONAL_ARGS[@]}"; do
    # Convert relative file paths to absolute paths
    if [ -f "$arg" ] || [ -d "$arg" ]; then
        # Convert to absolute path
        absolute_arg=$(cd "$(dirname "$arg")" 2>/dev/null && pwd)/$(basename "$arg") || echo "$arg"
        # On Windows (MSYS/Git Bash), convert /c/path back to C:\path for Bare runtime
        if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" || "$OSTYPE" == "cygwin" ]] || command -v cmd.exe >/dev/null 2>&1; then
            absolute_arg=$(echo "$absolute_arg" | sed 's|^/\([a-z]\)/|\1:/|' | sed 's|/|\\|g')
        fi
        escaped_arg=$(printf '%s\n' "$absolute_arg" | sed 's/["\\]/\\&/g')
    else
        # Not a file/directory path, escape as-is
        escaped_arg=$(printf '%s\n' "$arg" | sed 's/["\\]/\\&/g')
    fi
    ADDITIONAL_ARGS_JSON="$ADDITIONAL_ARGS_JSON\"$escaped_arg\","
done
# Remove trailing comma if there are arguments, or just close the array
if [ ${#ADDITIONAL_ARGS[@]} -gt 0 ]; then
    ADDITIONAL_ARGS_JSON="${ADDITIONAL_ARGS_JSON%,}"
fi
ADDITIONAL_ARGS_JSON="$ADDITIONAL_ARGS_JSON]"

# Create the script content with injected globals and conditional patches
SCRIPT_CONTENT="import process from 'bare-process'; 
globalThis.process = process;
// Inject additional arguments by overriding the argv property
const originalArgv = process.argv;
// Construct proper argv: [bare_executable, script_name, ...additional_args]
Object.defineProperty(process, 'argv', {
  value: [originalArgv[0], '$(basename "$INPUT_FILE")', ...$ADDITIONAL_ARGS_JSON],
  writable: false,
  enumerable: true,
  configurable: true
});
// Polyfill stdout.write for Bare compatibility
if (!process.stdout.write) {
  process.stdout.write = (data) => {
    const output = String(data).replace(/\n$/, '');
    if (output) console.log(output);
    return true;
  };
}"

# Add readline-specific helpers only if needed
if [ "$USES_READLINE" = "true" ]; then
    SCRIPT_CONTENT="$SCRIPT_CONTENT
// Readline polyfill for Bare runtime using direct stdin
const readline = {
  createInterface(options) {
    const eventHandlers = {};
    let inputBuffer = '';
    let isPrompting = false;
    
    process.stdin.setEncoding('utf8');
    
    const rlInterface = {
      on(event, handler) {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
        return this;
      },
      
      prompt() {
        isPrompting = true;
        process.stdout.write('> ');
        return this;
      },
      
      close() {
        const handlers = eventHandlers['close'] || [];
        handlers.forEach(h => h());
        return this;
      }
    };
    
    process.stdin.on('data', (chunk) => {
      inputBuffer += chunk;
      
      const lines = inputBuffer.split('\\n');
      inputBuffer = lines.pop() || '';
      
      for (const line of lines) {
        const input = line.trim();
        const handlers = eventHandlers['line'] || [];
        handlers.forEach(h => h(input));
      }
    });
    
         return rlInterface;
  }
};"
fi

SCRIPT_CONTENT="$SCRIPT_CONTENT
$PATCHED_CONTENT"

# Run with bare using -e flag, changing to the file's directory first
cd "$(dirname "$INPUT_FILE")"
bare -e "$SCRIPT_CONTENT"
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Completed successfully"
else
    echo "❌ Exited with code $EXIT_CODE"
fi

exit $EXIT_CODE
