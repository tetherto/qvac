# A real edit: @-reference a file, approve the change with its diff in view.
Output docs/assets/coding.gif
Output docs/assets/coding.mp4
Source docs/demo/common.tape

Hide
Type `cd docs/demo/project && cp .math.base math.mjs && alias qvac="node $PWD/../../../dist/index.js" && clear` Enter
Show
Type "qvac --temp --skip-setup --model Qwen3.5-9B-Q4_K_M --device-name Studio" Sleep 500ms Enter
Sleep 40s
Type "Add an exported average(values) function to @math" Sleep 800ms Tab
Sleep 300ms
Type "that reuses sum. Use edit_file." Sleep 500ms Enter
Sleep 60s
Screenshot docs/assets/approval.png
Type "y"
Sleep 20s
Screenshot docs/assets/diff.png
Sleep 2s
Ctrl+C Sleep 300ms Ctrl+C
Sleep 2s
