"""Installed-agent bridge for Harbor; Harbor owns tasks, sandboxes and verification."""

import json
import shlex
import tempfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.installed.node_install import nvm_node_install_snippet

from ..mcp_env import mcp_environment
from .openclaw_transcript import to_jsonl

OPENCLAW_TRANSCRIPT = "/root/.openclaw/agents/main/sessions/chat.jsonl"


class Arden(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        runtime_archive=None,
        profile_path=None,
        patch=False,
        case_id="harbor",
        transcript=None,
        prebuilt=False,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if not runtime_archive or not profile_path:
            raise ValueError("Pass runtime_archive and profile_path agent arguments")
        if not isinstance(patch, bool) or not isinstance(case_id, str):
            raise ValueError("patch must be boolean and case_id must be a string")
        if transcript not in (None, "openclaw"):
            raise ValueError('transcript must be omitted or "openclaw"')
        if not isinstance(prebuilt, bool):
            raise ValueError("prebuilt must be boolean")
        self.prebuilt = prebuilt
        self.patch = patch
        self.transcript = transcript
        self.case_id = case_id
        self.archive = Path(runtime_archive).resolve(strict=True)
        self.profile_path = Path(profile_path).resolve(strict=True)
        self.profile = json.loads(self.profile_path.read_text())
        if self.model_name and self.model_name != self.profile["model"]:
            raise ValueError("Harbor model and Arden profile model must match exactly")

    @staticmethod
    def name():
        return "arden"

    def get_version_command(self):
        return "cat /opt/arden/benchmark-build.json"

    async def install(self, environment):
        if self.prebuilt:
            # A Linux runtime exported from the arden-bench image (README): no
            # package manager or network, for tasks whose setup cannot reach one.
            await environment.upload_file(self.archive, "/opt/arden-runtime.tar.gz")
            await environment.upload_file(self.profile_path, "/opt/arden-profile.json")
            await self.exec_as_root(
                environment,
                command=(
                    "set -eu; tar -xzf /opt/arden-runtime.tar.gz -C /; "
                    "/usr/local/bin/arden-bench-node --version; command -v python3"
                ),
            )
            return
        await self.ensure_system_dependencies(environment, ("curl", "python3", "git"))
        await self.exec_as_root(
            environment,
            command="command -v apt-get >/dev/null && apt-get update -qq && apt-get install -y bubblewrap build-essential",
        )
        result = await environment.exec("mkdir -p /opt/arden", user="root")
        if result.return_code != 0:
            raise RuntimeError("Cannot create runtime directory")
        await environment.upload_file(self.archive, "/opt/arden-runtime.tar.gz")
        await environment.upload_file(self.profile_path, "/opt/arden-profile.json")
        # Install native dependencies in Linux, never copy the macOS node_modules.
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                + nvm_node_install_snippet(node_major=24)
                + "; npm install -g bun@1.3.10; "
                "tar -xzf /opt/arden-runtime.tar.gz -C /opt/arden; "
                "sh /opt/arden/benchmarks/install.sh; "
                'cp "$(command -v node)" /usr/local/bin/arden-bench-node'
            ),
        )

    async def _collect(self, environment):
        """Stop a runner Harbor's time limit left behind, then copy out what it wrote.

        Harbor cancels `run` at the task's time limit while the runner is still
        working. The runner writes its transcript and token counts when it stops,
        so it is told to stop and given time to finish before the copy. A failure
        here is logged, never raised: it must not hide why the run failed.
        """
        steps = (
            (
                "stop the runner",
                lambda: environment.exec(
                    "pid=$(cat /tmp/arden-trial/candidate.pid 2>/dev/null) || exit 0; "
                    'kill -TERM "$pid" 2>/dev/null || exit 0; '
                    'n=0; while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 90 ]; '
                    "do sleep 0.5; n=$((n + 1)); done",
                    timeout_sec=60,
                ),
            ),
            (
                "copy the trial folder",
                lambda: environment.download_dir(
                    "/tmp/arden-trial", (self.logs_dir / "arden").resolve()
                ),
            ),
            *(
                [("write the OpenClaw transcript", lambda: self._write_openclaw_transcript(environment))]
                if self.transcript == "openclaw"
                else []
            ),
        )
        for name, step in steps:
            try:
                await step()
            except Exception as error:
                self.logger.warning("Arden adapter could not %s: %s", name, error)

    async def run(self, instruction, environment, context):
        workspace = await environment.exec("pwd")
        if workspace.return_code != 0:
            raise RuntimeError("Cannot determine task workspace")
        with tempfile.TemporaryDirectory(prefix="arden-harbor-") as temporary:
            prompt = Path(temporary) / "prompt.txt"
            prompt.write_text(self.render_instruction(instruction))
            await environment.upload_file(prompt, "/opt/arden-prompt.txt")
        credential = self._get_env(self.profile["apiKeyEnv"])
        if not credential:
            raise ValueError(f"Missing {self.profile['apiKeyEnv']}")
        credentials = {self.profile["apiKeyEnv"]: credential}
        if account_env := self.profile.get("accountIdEnv"):
            account = self._get_env(account_env)
            if not account:
                raise ValueError(f"Missing {account_env}")
            credentials[account_env] = account
        # Variables a benchmark-owned MCP server reads; exec_command never sees host variables.
        credentials.update(mcp_environment(self.profile, self._get_env))
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    "/usr/local/bin/arden-bench-node --version && "
                    "python3 /opt/arden/benchmarks/cli.py single "
                    "--profile /opt/arden-profile.json --prompt-file /opt/arden-prompt.txt "
                    f"--workspace {shlex.quote(workspace.stdout.strip())} "
                    f"--output /tmp/arden-trial --id {shlex.quote(self.case_id)} --allow-model-calls"
                    + (" --patch" if self.patch else "")
                ),
                env={
                    **credentials,
                    "ARDEN_BENCH_NODE": "/usr/local/bin/arden-bench-node",
                },
            )
        finally:
            await self._collect(environment)

    async def _write_openclaw_transcript(self, environment):
        """Give transcript-reading graders (WildClawBench) the session in OpenClaw's format."""
        session = self.logs_dir / "arden/observations/session.json"
        if not session.exists():
            return
        with tempfile.TemporaryDirectory(prefix="arden-harbor-") as temporary:
            chat = Path(temporary) / "chat.jsonl"
            chat.write_text(to_jsonl(json.loads(session.read_text())))
            await environment.upload_file(chat, "/tmp/arden-chat.jsonl")
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {shlex.quote(str(Path(OPENCLAW_TRANSCRIPT).parent))} && "
                f"cp /tmp/arden-chat.jsonl {shlex.quote(OPENCLAW_TRANSCRIPT)}"
            ),
        )

    def populate_context_post_run(self, context):
        usage = self.logs_dir / "arden/observations/usage.json"
        if usage.exists():
            recorded = json.loads(usage.read_text())
            # Harbor's input count includes cached tokens; promptTokens does not.
            context.n_input_tokens = (
                recorded["promptTokens"]
                + recorded["cacheReadTokens"]
                + recorded["cacheWriteTokens"]
            )
            context.n_cache_tokens = recorded["cacheReadTokens"]
            context.n_output_tokens = recorded["completionTokens"]
