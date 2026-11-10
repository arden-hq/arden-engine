#!/usr/bin/env python3
"""Prepare one generation-only Harbor task from an official SWE-bench Pro row."""

import argparse
import json
import re
from pathlib import Path
from datasets import case_for, read_rows
from cli import write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("data", "id", "image", "output"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    # Caller supplies the official instance image, preferably by immutable digest.
    if not re.fullmatch(r"[a-zA-Z0-9._/@:-]+", args.image):
        raise ValueError("Invalid image reference")
    selected = [row for row in read_rows(args.data) if row["instance_id"] == args.id]
    if len(selected) != 1:
        raise ValueError("Expected exactly one matching instance")
    row = selected[0]
    base = row["base_commit"]
    if not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("Invalid base commit")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    (output / "environment").mkdir()
    (output / "instruction.md").write_text(
        case_for("swe-bench-pro", row)["prompts"][0] + "\n"
    )
    (output / "task.toml").write_text(
        'version = "1.0"\n[agent]\ntimeout_sec = 1800\n[environment]\nbuild_timeout_sec = 600\n'
    )
    (output / "environment/Dockerfile").write_text(
        f"FROM {args.image}\nWORKDIR /app\nRUN "
        + json.dumps(["git", "reset", "--hard", base])
        + "\nRUN "
        + json.dumps(["git", "clean", "-fd"])
        + "\n"
    )
    # Keep only generation provenance. No test names, expected answers or test patches.
    write_json(
        output / "generation.json",
        {
            "instance_id": args.id,
            "base_commit": base,
            "image": args.image,
            "grading": "Run the pinned official SWE-bench Pro evaluator on exported prediction.json; disable Harbor verification for this generation task.",
        },
    )
    print(output)


if __name__ == "__main__":
    main()
