# bench

`polyglot.mjs` runs Aider's polyglot benchmark (225 Exercism exercises in C++, Go, Java,
JavaScript, Python and Rust, pinned to one commit) through the real `qvac -p`, so a score is what
the app does: our instructions, the coding plugin, the sandbox and the harness.

Each exercise is a fresh git copy. The agent gets the exercise's instructions and two tries; the
second carries the failing test output, as in Aider's benchmark. Exercism skips every test but the
first, so the copy un-skips them all, and the test files are restored before each scoring run.

## Setup, once per machine

```sh
# toolchains: python3, go, cargo, cmake + a C++ compiler, node, a JDK
qvac serve --create --account-name Bench --device-name Bench --data-dir <bench-data>   # Ctrl+C once ready
qvac --data-dir <bench-data> models pull Qwen3.6-35B-A3B-UD-Q4_K_M
cd output/bench/js-deps && npm install            # the test packages every JS exercise shares
```

Java runs `./gradlew test --offline`, so warm Gradle's cache once with one exercise:
`(cd output/bench/polyglot-benchmark/java/exercises/practice/bowling && ./gradlew test)`.

The first run clones the benchmark into `output/bench/polyglot-benchmark`. After setup nothing needs
the network.

## Running

The script imports the built CLI from `dist/`, so run `npm run build` first, and again after a
change.

```sh
node benchmarks/coding/polyglot.mjs --model Qwen3.6-35B-A3B-UD-Q4_K_M --data-dir <bench-data>
```

| flag                  | default              | what it does                                                    |
| --------------------- | -------------------- | --------------------------------------------------------------- |
| `--languages`         | `python,go,rust,cpp` | add `javascript,java` once set up                               |
| `--limit n`           | all                  | n exercises, taken from every language in turn                  |
| `--exercises`         | all                  | `bowling` or `go/bowling`, comma-separated                      |
| `--tries`             | `2`                  |                                                                 |
| `--reasoning`         | `on`                 | `off`, or `plan`: think after the prompt and after a failure    |
| `--budget n`          | the model's own      | caps each round's thinking in tokens                            |
| `--ctx n`             | the harness's choice | the context window of every load (`harness.llm.contextSize`)    |
| `--wording file`      | none                 | a JSON file of `harness.wording`, e.g. guidelines to drop       |
| `--skills list`       | the CLI's skills     | the skills the agent may load; `''` offers none                 |
| `--plugins file`      | the sandbox only     | a JSON file of `harness.plugins` entries added to the sandbox   |
| `--tool-configs file` | none                 | a JSON file of `core.agent.toolConfigs`, e.g. `edit_file` forms |
| `--disable list`      | none                 | toolsets the agent is not offered, e.g. `exec`                  |
| `--plain`             | off                  | the workflow alone, without the project's folder and test line  |
| `--protocol`          | `agent`              | `aider`: Aider's protocol, see below                            |
| `--bwrap path`        | `/usr/bin/bwrap`     | the sandbox's `bwrap`, for a box that needs a wrapper           |
| `--cli dir`           | this checkout        | another CLI copy, e.g. one pinned to a harness branch           |
| `--timeout-min`       | `20`                 | per try                                                         |

A run writes `output/bench/runs/<stamp>-<model>/`: `results.jsonl` (one row per exercise: tries,
seconds, tool calls, tokens), each try's transcript under `runs/`, and the final code under `work/`.
It ends with pass@1, pass@2 and the mean seconds per exercise. A try that fails before its first
tool call is the machine's, not the model's, and is run once more (`infraRetry`).

## Comparing with Aider's numbers

Aider's own runs never show the model the test files and give it no shell. Our agent reads and
runs the tests on its first try, as a coding agent does, so the default `agent` protocol scores the
app, not a number on Aider's leaderboard.

`--protocol aider` is the comparable run. The shell, `exec` and web toolsets are off, and the test files
are removed from the exercise while the agent works and put back for scoring, so the only test
output it ever sees is the failing run between its two tries. Its pass@2 is Aider's `pass_rate_2`.

That output is cleaned as Aider cleans it, of timings and the exercise's full path. Aider sends
all of it; a C++ build can print 80 KB of one repeated error, more than fits beside the first try
in the model's context, so output past 16,000 characters keeps its first 12,000 and its last 4,000.
