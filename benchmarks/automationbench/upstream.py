#!/usr/bin/env python3
"""Upstream-side helpers run in the AutomationBench environment: list, prompt, grade."""

import argparse
import json
from pathlib import Path

from common import load_task, task_ids, task_text


def grade(upstream, domain, task_id, state_file):
    from automationbench.rubric import partial_credit, task_completed_correctly
    from automationbench.schema.world import WorldState

    _, state = load_task(upstream, domain, task_id)
    state["world"] = WorldState.model_validate(json.loads(Path(state_file).read_text()))
    credit = partial_credit(state)
    return {
        "passed": bool(task_completed_correctly(state)),
        "partial_credit": credit,
        "assertions": state.get("_assertion_results", []),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["list", "prompt", "grade"])
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--task-id")
    parser.add_argument("--state")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.action == "list":
        result = task_ids(args.upstream, args.domain)
    elif args.action == "prompt":
        _, state = load_task(args.upstream, args.domain, args.task_id)
        result = task_text(state)
    else:
        result = grade(args.upstream, args.domain, args.task_id, args.state)
    # Upstream prints its own summaries to stdout at exit, so results go to a file.
    Path(args.out).write_text(json.dumps(result))


if __name__ == "__main__":
    main()
