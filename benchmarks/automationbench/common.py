"""Task loading shared by the bridge and the grader; the upstream env owns state setup."""

import asyncio
import sys
from pathlib import Path


def use_upstream(upstream):
    sys.path.insert(0, str(Path(upstream).resolve()))


def task_ids(upstream, domain):
    use_upstream(upstream)
    from automationbench.domains import DOMAINS

    return sorted(str(row["example_id"]) for row in DOMAINS[domain]())


def load_task(upstream, domain, task_id):
    """Return (env, state) exactly as AutomationBenchEnv.setup_state builds them."""
    use_upstream(upstream)
    from verifiers.types import ClientConfig

    from automationbench.domains import DOMAINS
    from automationbench.rubric import create_rubric
    from automationbench.runner import AutomationBenchEnv

    dataset = DOMAINS[domain]()
    indexes = [
        i for i, row in enumerate(dataset) if str(row["example_id"]) == str(task_id)
    ]
    if len(indexes) != 1:
        raise ValueError(f"Task {task_id} in {domain}: {len(indexes)} matches")
    env = AutomationBenchEnv(
        dataset=dataset.select(indexes),
        rubric=create_rubric(),
        toolset="api",
        max_turns=50,
    )

    async def setup():
        # The client is never called; the config only satisfies state construction.
        state = await env.init_state(
            dict(dataset[indexes[0]]), ClientConfig(api_key_var="PATH"), "none"
        )
        return await env.setup_state(state)

    return env, asyncio.run(setup())


def task_text(state):
    """The upstream system text, a blank line, then the task text."""
    messages = state["prompt"]
    system = [m.content for m in messages if m.role == "system"]
    rest = [m.content for m in messages if m.role != "system"]
    return "\n\n".join(system + rest)
