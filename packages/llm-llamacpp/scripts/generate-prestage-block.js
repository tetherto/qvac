'use strict'
// Emit the YAML value for the mobile workflow's `extra-pre-test-commands`
// input: a self-contained host script (run in the Device Farm pre_test phase,
// where the network is reliable) that pre-stages exactly the models THIS shard
// needs onto the device at /data/local/tmp/prestaged-models, so the phone never
// downloads from huggingface.co. The shard is identified at runtime from the
// grep pattern in the decoded wdio config; models come from model-manifest.json
// (base64-embedded here so it is available on the host without shipping it in
// the test package). Run `node scripts/generate-prestage-block.js` and paste the
// output under `extra-pre-test-commands:` (indented), or use --check in CI to
// assert the workflow is up to date.
const fs = require('fs')
const path = require('path')

const manifestPath = path.resolve(__dirname, '../test/mobile/model-manifest.json')
const manifestB64 = Buffer.from(fs.readFileSync(manifestPath)).toString('base64')

// Host script. Kept POSIX-sh friendly; node + adb + curl are all available in
// the Device Farm pre_test phase.
const script = `set -e
PRESTAGE_DIR=/data/local/tmp/prestaged-models
echo "${manifestB64}" | base64 -d > /tmp/model-manifest.json
GREP=$(node -e "const fs=require('fs');try{const s=fs.readFileSync('tests/wdio.config.devicefarm.js','utf8');const m=s.match(/grep:\\s*'([^']*)'/);process.stdout.write(m?m[1]:'')}catch(e){process.stdout.write('')}")
export GREP
echo "[prestage] shard grep: '$GREP'"
node -e "const fs=require('fs');const man=JSON.parse(fs.readFileSync('/tmp/model-manifest.json','utf8'));const g=process.env.GREP||'';const tests=g?g.split('|').map(s=>s.trim()).filter(Boolean):Object.keys(man);const seen=new Set();const out=[];for(const t of tests){for(const m of (man[t]||[])){if(!seen.has(m.name)){seen.add(m.name);out.push(m.name+'\\t'+m.url)}}}fs.writeFileSync('/tmp/prestage-list.tsv',out.join('\\n')+(out.length?'\\n':''));console.error('[prestage] '+out.length+' model(s) for '+tests.length+' test(s)')"
adb shell mkdir -p "$PRESTAGE_DIR"
mkdir -p /tmp/prestage
while IFS=$(printf '\\t') read -r NAME URL; do
  [ -z "$NAME" ] && continue
  echo "[prestage] staging $NAME"
  curl -fSL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 1800 -o "/tmp/prestage/$NAME" "$URL"
  adb push "/tmp/prestage/$NAME" "$PRESTAGE_DIR/$NAME"
  adb shell test -s "$PRESTAGE_DIR/$NAME" || { echo "[prestage] FATAL: $NAME not present on device after push"; exit 1; }
  rm -f "/tmp/prestage/$NAME"
done < /tmp/prestage-list.tsv
echo "[prestage] device contents:"
adb shell ls -la "$PRESTAGE_DIR" || true
echo "[prestage] done"`

// emit_extra_commands in generate-testspec.sh treats a lone "|" line as the
// start of a YAML literal block whose body lines are indented by 2 spaces.
const body = script
  .split('\n')
  .map((l) => '  ' + l)
  .join('\n')
process.stdout.write('|\n' + body + '\n')
