"""Harbor ACP agent that runs omp (`omp acp`) inside each Terminal-Bench task container.

It reuses Harbor's generic ACP adapter (AcpAgent: acp_runner.py, auto-approved
permissions, ACP trajectory). Before the adapter installs its runner, this class
uploads the omp binary, an omp configuration, the router plugin, and stored
credentials into the container. After the run, it copies omp's session files into
the trial logs, so bench/terminal_bench/report.py can read cost and routing.

Agent kwargs (pass with --ak key=value):
  router   none | prompt-both | prompt-both+step-effort | prompt-both+step-both
  creds    path to an `omp auth export` file on the host (keep it secret); it must
           hold every credential the run needs, including openrouter for the judge
"""

import json
import shlex
from pathlib import Path

from harbor.agents.installed.acp import AcpAgent, AcpOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field

PLUGIN_DIR = Path(__file__).resolve().parents[2]
OMP_HOME = "/installed-agent/omp-agent"
ROUTERS = {
    "none": None,
    "prompt-both": {"prompt": ["model", "effort"], "step": []},
    "prompt-both+step-effort": {"prompt": ["model", "effort"], "step": ["effort"]},
    "prompt-both+step-both": {"prompt": ["model", "effort"], "step": ["model", "effort"]},
}
CONFIG = """advisor:
  enabled: false
modelRoles:
  default: anthropic/claude-opus-5-5
  smol: zai/glm-5.3-flash
defaultThinkingLevel: auto
"""


class OmpAcpOptions(AcpOptions):
    router: str = Field(default="prompt-both", description="Router configuration name.")
    creds: str = Field(default="", description="Path to an `omp auth export` file.")
    omp_bin: str = Field(default="", description="Path to the omp binary.")


class OmpAcpAgent(AcpAgent):
    options_model = OmpAcpOptions

    def __init__(self, *args, router: str = "prompt-both", creds: str = "", omp_bin: str = "", **kwargs):
        if router not in ROUTERS:
            raise ValueError(f"router must be one of {', '.join(ROUTERS)}")
        self._router = router
        self._creds = Path(creds).expanduser()
        self._omp_bin = Path(omp_bin or Path.home() / ".local/bin/omp")
        env = {"PI_CODING_AGENT_DIR": OMP_HOME, "JUDGE_ROUTER_CONFIG": f"{OMP_HOME}/router.json"}
        entry = {
            "id": "omp",
            "name": "omp",
            "version": f"omp+{router}",
            "description": "oh-my-pi coding agent over ACP",
            "distribution": {"local": {"cmd": "/installed-agent/omp", "args": ["acp"], "env": env}},
        }
        super().__init__(*args, registry_entry=entry, **kwargs)

    @staticmethod
    def name() -> str:
        return "omp-acp"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(environment, command=f"mkdir -p {OMP_HOME}/plugin")
        await environment.upload_file(source_path=self._omp_bin, target_path="/installed-agent/omp")
        config = CONFIG
        router = ROUTERS[self._router]
        if router is not None:
            for name in ("judge-model-router.ts", "package.json"):
                await environment.upload_file(source_path=PLUGIN_DIR / name, target_path=f"{OMP_HOME}/plugin/{name}")
            config += f"extensions:\n  - {OMP_HOME}/plugin\n"
            router_file = self.logs_dir / "router.json"
            router_file.write_text(json.dumps(router))
            await environment.upload_file(source_path=router_file, target_path=f"{OMP_HOME}/router.json")
        config_file = self.logs_dir / "omp-config.yml"
        config_file.write_text(config)
        await environment.upload_file(source_path=config_file, target_path=f"{OMP_HOME}/config.yml")
        await environment.upload_file(source_path=self._creds, target_path=f"{OMP_HOME}/credentials.json")
        command = (
            "chmod +x /installed-agent/omp"
            f" && PI_CODING_AGENT_DIR={OMP_HOME} /installed-agent/omp auth import {OMP_HOME}/credentials.json"
            f" && rm {OMP_HOME}/credentials.json"
        )
        if environment.default_user is not None:
            command += f" && chown -R {shlex.quote(str(environment.default_user))} /installed-agent"
        await self.exec_as_root(environment, command=command)
        await super().install(environment)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        try:
            await super().run(instruction, environment, context)
        finally:
            # Session files only; the omp home also holds the imported credentials.
            await environment.exec(
                command=f"mkdir -p /logs/agent/omp-sessions && cp -r {OMP_HOME}/sessions/. /logs/agent/omp-sessions/ 2>/dev/null; true",
                user="root",
            )
