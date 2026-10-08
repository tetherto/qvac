import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SPEECH_PACKAGES = new Set(['asr-ggml', 'tts-ggml', 'audiogen-ggml', 'bci-whispercpp'])
const CPP_FILE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/

export function selectCppLintRows(rows, changedFiles) {
  return rows.filter((row) => row.hasCppLint === true && (
    changedFiles === null || !SPEECH_PACKAGES.has(row.package) ||
    changedFiles.some((file) => file.startsWith(`${row.workdir}/`) && CPP_FILE.test(file))
  ))
}

function main() {
  const changedFiles = process.env.EVENT_NAME === 'pull_request_target'
    ? readFileSync(process.env.CHANGED_FILES, 'utf8').split(/\r?\n/).filter(Boolean)
    : null
  console.log(`cpplint=${JSON.stringify(selectCppLintRows(JSON.parse(process.env.M), changedFiles))}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
