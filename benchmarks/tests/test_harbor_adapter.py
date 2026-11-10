"""The Harbor adapter against a stand-in for Harbor's base class; Harbor itself is not run."""

import asyncio
import json
import logging
import sys
import tempfile
import types
import unittest
from pathlib import Path


class BaseInstalledAgent:
    def __init__(self, logs_dir=None, model_name=None):
        self.logs_dir = Path(logs_dir)
        self.model_name = model_name
        self.logger = logging.getLogger("arden-harbor-test")
        self.logger.disabled = True

    def render_instruction(self, instruction):
        return instruction

    def _get_env(self, name):
        return "value"

    async def exec_as_agent(self, environment, command, env=None):
        return await environment.exec(command, env=env)

    async def exec_as_root(self, environment, command):
        return await environment.exec(command, user="root")


def install_stand_in():
    for name in ("harbor", "harbor.agents", "harbor.agents.installed"):
        sys.modules.setdefault(name, types.ModuleType(name))
    base = types.ModuleType("harbor.agents.installed.base")
    base.BaseInstalledAgent = BaseInstalledAgent
    node = types.ModuleType("harbor.agents.installed.node_install")
    node.nvm_node_install_snippet = lambda node_major: "true"
    sys.modules["harbor.agents.installed.base"] = base
    sys.modules["harbor.agents.installed.node_install"] = node


install_stand_in()
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from benchmarks.adapters.harbor import Arden  # noqa: E402


class Result:
    return_code = 0
    stdout = "/task\n"


class Environment:
    """Fails the run and the copy, like a trial Harbor stopped in a broken container."""

    def __init__(self, observations=None):
        self.commands = []
        self.observations = observations

    async def exec(self, command, **options):
        self.commands.append(command)
        if "cli.py single" in command:
            raise RuntimeError("run failed")
        return Result()

    async def upload_file(self, source, target):
        self.commands.append(f"upload {target}")

    async def download_dir(self, source, target):
        if self.observations is None:
            raise OSError("copy failed")
        self.copied = source
        folder = Path(target) / "observations"
        folder.mkdir(parents=True, exist_ok=True)
        for name, value in self.observations.items():
            (folder / name).write_text(json.dumps(value))


class HarborAdapter(unittest.TestCase):
    def agent(self, root, **options):
        (root / "runtime.tar.gz").write_bytes(b"")
        (root / "profile.json").write_text(json.dumps({"model": "m", "apiKeyEnv": "KEY"}))
        return Arden(
            logs_dir=root / "logs",
            runtime_archive=str(root / "runtime.tar.gz"),
            profile_path=str(root / "profile.json"),
            **options,
        )

    def test_a_failed_copy_does_not_hide_the_run_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            environment = Environment()
            with self.assertRaisesRegex(RuntimeError, "run failed"):
                asyncio.run(self.agent(Path(temporary)).run("task", environment, None))
            stop = [command for command in environment.commands if "candidate.pid" in command]
            self.assertEqual(len(stop), 1)
            self.assertIn("kill -TERM", stop[0])
            self.assertIn("driver.pid", stop[0])

    def test_each_run_has_its_own_folder_and_the_database_is_not_copied(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = self.agent(Path(temporary))
            folders = []
            for _ in range(2):
                environment = Environment({})
                with self.assertRaisesRegex(RuntimeError, "run failed"):
                    asyncio.run(agent.run("task", environment, None))
                folders.append(agent.trial)
                run = next(c for c in environment.commands if "cli.py single" in c)
                self.assertIn(f"--output {agent.trial} ", run)
                self.assertIn("--keep-home", run)
                self.assertIn(f"rm -rf {agent.trial}/state {agent.trial}/home", environment.commands)
                self.assertEqual(environment.copied, agent.trial)
            self.assertNotEqual(*folders)

    def test_transcript_and_tokens_are_collected_after_a_failed_run(self):
        archive = {
            "format": "arden.session.archive",
            "transcript": {
                "records": [{"sequence": 0, "envelope": {"role": "assistant", "content": "hi"}}]
            },
        }
        usage = {
            "promptTokens": 10,
            "cacheReadTokens": 30,
            "cacheWriteTokens": 5,
            "completionTokens": 7,
        }
        with tempfile.TemporaryDirectory() as temporary:
            environment = Environment({"session.json": archive, "usage.json": usage})
            agent = self.agent(Path(temporary), transcript="openclaw")
            with self.assertRaisesRegex(RuntimeError, "run failed"):
                asyncio.run(agent.run("task", environment, None))
            self.assertIn("upload /tmp/arden-chat.jsonl", environment.commands)
            context = types.SimpleNamespace()
            agent.populate_context_post_run(context)
            self.assertEqual(
                (context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens),
                (45, 30, 7),
            )


if __name__ == "__main__":
    unittest.main()
