"""Terminal-Bench through the real `qvac -p`, inside each task's container.

Harbor loads it as -a qvac_agent:Qvac. Nothing is installed per task: the README's run mounts a
built CLI, its Node, bwrap, the GPU libraries and the model folder under /opt/qvac, and the GPU
device nodes. The agent is what the TUI loads in a project: the coding workflow, its
tools, skills and plugins, and the shell in its sandbox, with the container granted to it, since a
task installs packages and edits system files as leaderboard agents may.
"""

import json
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

ROOT = "/opt/qvac"
DATA = "/tmp/qvac-data"
ENV = {
    "PATH": f"{ROOT}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LD_LIBRARY_PATH": f"{ROOT}/lib",
    # the CUDA backend uses libstdc++ without linking it, and an image may carry an older one
    "LD_PRELOAD": f"{ROOT}/lib/libstdc++.so.6",
}
WRITABLE = ["/usr", "/etc", "/opt", "/root", "/home", "/var", "/srv", "/tmp", "/mnt"]
QVAC = f"node {ROOT}/cli/dist/index.js --data-dir {DATA}"


class Qvac(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "qvac"

    def get_version_command(self) -> str | None:
        return f"{ROOT}/bin/node {ROOT}/cli/dist/index.js --version"

    def parse_version(self, stdout: str) -> str:
        return stdout.split("\n")[0].removeprefix("@qvac/cli").strip()

    # a fresh device per task: two containers on one identity would write the same cores
    async def install(self, environment: BaseEnvironment) -> None:
        setup = (
            f"{QVAC} serve --json --non-interactive --no-default-models"
            f" --account-name Bench --device-name tb > /tmp/qvac-serve.out 2>&1 & pid=$!; "
            'for i in $(seq 1 120); do grep -q \'"status":"ready"\' /tmp/qvac-serve.out && break; sleep 1; done; '
            'kill $pid; wait $pid; grep -q \'"status":"ready"\' /tmp/qvac-serve.out || { cat /tmp/qvac-serve.out; exit 1; }'
        )
        await self.exec_as_agent(environment, command=setup, env=ENV)

    def populate_context_post_run(self, context: AgentContext) -> None:
        pass

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        config = {
            "core": {
                "model": self.model_name.split("/")[-1],
                "modelsDir": f"{ROOT}/models",
                "agent": {"reasoning": "disabled"},
            },
            # the mounted bwrap binds the container's /proc, which a rootless one cannot remount
            # the container is the user's to give: the shell reads it all and also writes where
            # tasks install and configure, while the project, the one workspace, stays the task's
            "harness": {
                "plugins": [
                    {
                        "id": "sandbox-linux",
                        "options": {"bwrap": f"{ROOT}/bin/bwrap", "writable": WRITABLE},
                    }
                ],
                "policy": {"files": {"read": "all"}},
            },
        }
        await self.exec_as_agent(
            environment,
            command=(
                f"printf '%s' {shlex.quote(json.dumps(config))} > /tmp/qvac.config.json; "
                f"{QVAC} --config /tmp/qvac.config.json --yes --mode json --new -p -- "
                f"{shlex.quote(instruction)} > /logs/agent/qvac.jsonl 2>&1"
            ),
            env=ENV,
        )
