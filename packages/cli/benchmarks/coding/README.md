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

```sh
node benchmarks/coding/polyglot.mjs --model Qwen3.6-35B-A3B-UD-Q4_K_M --data-dir <bench-data>
```

| flag             | default              | what it does                                                   |
| ---------------- | -------------------- | -------------------------------------------------------------- |
| `--languages`    | `python,go,rust,cpp` | add `javascript,java` once set up                              |
| `--limit n`      | all                  | n exercises, taken from every language in turn                 |
| `--exercises`    | all                  | `bowling` or `go/bowling`, comma-separated                     |
| `--tries`        | `2`                  |                                                                |
| `--reasoning`    | `on`                 | `off`, or `plan`: think after the prompt and after a failure   |
| `--budget n`     | the model's own      | caps each round's thinking in tokens                           |
| `--disable list` | none                 | toolsets the agent is not offered, e.g. `exec`                 |
| `--plain`        | off                  | the workflow alone, without the project's folder and test line |
| `--cli dir`      | this checkout        | another CLI copy, e.g. one pinned to a harness branch          |
| `--timeout-min`  | `20`                 | per try                                                        |

A run writes `output/bench/runs/<stamp>-<model>/`: `results.jsonl` (one row per exercise: tries,
seconds, tool calls, tokens), each try's transcript under `runs/`, and the final code under `work/`.
It ends with pass@1, pass@2 and the mean seconds per exercise. A try that fails before its first
tool call is the machine's, not the model's, and is run once more (`infraRetry`).

## Comparing with Aider's numbers

Aider's own runs never show the model the test files and give it no shell. Our agent reads and
runs the tests on its first try, as a coding agent does, so pass@1 here is not Aider's pass_rate_1.
pass@2 is the closer comparison.
