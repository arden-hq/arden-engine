#!/usr/bin/env python3
"""Grade saved predictions with pinned upstream scorers, without rerunning Arden."""

import argparse
import dataclasses
import importlib
import json
import os
import shutil
import subprocess
import sys
import types
import uuid
from pathlib import Path

from cli import digest, write_json
from datasets import read_rows


def normalize_browse_grade(value):
    # Pinned upstream returns group(0), but its caller compares with yes/no.
    if value in ("yes", "no"):
        return value
    if value in ("correct: yes", "correct: no"):
        return value.split(": ")[1]
    raise ValueError(f"Unrecognized upstream judge result: {value!r}")


def grade_browse(args, output):
    package = types.ModuleType("arden_simple_evals")
    package.__path__ = [str(args.upstream)]
    sys.modules[package.__name__] = package
    module = importlib.import_module("arden_simple_evals.browsecomp_eval")
    sampler_module = importlib.import_module(
        "arden_simple_evals.sampler.chat_completion_sampler"
    )
    native_types = importlib.import_module("arden_simple_evals.types")
    predictions = read_rows(args.predictions)
    by_id = {str(row["id"]): row["response"] for row in predictions}
    if len(by_id) != len(predictions):
        raise ValueError("Duplicate prediction IDs")
    examples, answers = [], {}
    for index, row in enumerate(read_rows(args.data)):
        identity = str(row.get("id", row.get("problem_id", index)))
        if identity not in by_id:
            continue
        prompt = module.QUERY_TEMPLATE.format(
            # A row without a canary is plain text, as in datasets.case_for.
            Question=module.decrypt(row["problem"], row["canary"])
            if row.get("canary")
            else row["problem"]
        )
        if prompt in answers:
            raise ValueError("Duplicate BrowseComp question")
        answers[prompt] = by_id[identity]
        examples.append(row)
    if len(examples) != len(by_id):
        raise ValueError("Prediction IDs missing from dataset")

    class Replay(native_types.SamplerBase):
        def _pack_message(self, role, content):
            return {"role": role, "content": content}

        def __call__(self, messages):
            return native_types.SamplerResponse(
                answers[messages[-1]["content"]], messages, {}
            )

    class CorrectedParser(module.BrowseCompEval):
        def grade_sample(self, question, correct_answer, response):
            return normalize_browse_grade(
                super().grade_sample(question, correct_answer, response)
            )

    # Avoid upstream's implicit network dataset download; use the hashed local file.
    evaluator = CorrectedParser.__new__(CorrectedParser)
    evaluator.examples = examples
    provider_profile = getattr(args, "provider_profile", None)
    if provider_profile:

        class ProfileJudge(native_types.SamplerBase):
            def _pack_message(self, role, content):
                return {"role": role, "content": content}

            def __call__(self, messages):
                response = subprocess.run(
                    [
                        os.environ.get("ARDEN_BENCH_NODE", "node"),
                        str(Path(__file__).with_name("judge.mjs")),
                        str(provider_profile),
                    ],
                    input=json.dumps(messages),
                    text=True,
                    capture_output=True,
                    timeout=args.judge_timeout,
                    check=True,
                )
                record = json.loads(response.stdout)
                record["prompt_sha256"] = digest(json.dumps(messages).encode())
                write_json(output / f"judge-{uuid.uuid4().hex}.json", record)
                return native_types.SamplerResponse(
                    record["text"], messages, {"usage": record["usage"]}
                )

        evaluator.grader_model = ProfileJudge()
    else:
        evaluator.grader_model = sampler_module.ChatCompletionSampler(
            model=args.judge, temperature=0
        )
    result = evaluator(Replay())
    write_json(
        output / "score.json",
        {
            "scorer_variant": "upstream-with-correct-label-parser-v1",
            "judge_transport": "arden-provider-profile"
            if provider_profile
            else "upstream-chat-completions",
            "result": dataclasses.asdict(result),
        },
    )


def commands(args, output):
    if args.suite == "longmemeval":
        return [
            [
                sys.executable,
                str(args.upstream / "src/evaluation/evaluate_qa.py"),
                args.judge,
                str(output / "predictions.jsonl"),
                str(args.data),
            ]
        ]
    raw = output / "raw"
    raw.mkdir()
    shutil.copyfile(args.predictions, raw / "arden.jsonl")
    race = [
        sys.executable,
        "deepresearch_bench_race.py",
        "arden",
        "--raw_data_dir",
        str(raw),
        "--cleaned_data_dir",
        str(output / "cleaned"),
        "--query_file",
        str(args.data),
        "--output_dir",
        str(output / "race"),
        "--max_workers",
        "1",
    ]
    chain = [race]
    previous = raw / "arden.jsonl"
    for step in ("extract", "deduplicate", "scrape", "validate"):
        target = output / f"{step}.jsonl"
        command = [
            sys.executable,
            "-m",
            f"utils.{step}",
            "--raw_data_path",
            str(previous),
            "--output_path",
            str(target),
            "--n_total_process",
            "1",
        ]
        if step != "scrape":
            command += ["--query_data_path", str(args.data)]
        chain.append(command)
        previous = target
    chain.append(
        [
            sys.executable,
            "-m",
            "utils.stat",
            "--input_path",
            str(previous),
            "--output_path",
            str(output / "fact_result.txt"),
        ]
    )
    return chain


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--suite", required=True, choices=["longmemeval", "browsecomp", "deepresearch"]
    )
    for name in ("upstream", "predictions", "data", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--judge")
    parser.add_argument("--provider-profile", type=Path)
    parser.add_argument("--allow-judge-calls", action="store_true")
    args = parser.parse_args()
    if not args.allow_judge_calls:
        raise ValueError("Grading may cost money; pass --allow-judge-calls")
    if args.suite != "deepresearch" and not args.judge:
        raise ValueError("--judge is required")
    judge_profile = None
    if args.provider_profile:
        if args.suite != "browsecomp":
            raise ValueError("--provider-profile currently supports BrowseComp only")
        args.provider_profile = args.provider_profile.resolve(strict=True)
        judge_profile = json.loads(args.provider_profile.read_text())
        if args.judge != judge_profile["model"]:
            raise ValueError("Judge and profile model must match")
        args.judge_timeout = judge_profile["timeoutMs"] / 1000 + 60
    if args.suite == "deepresearch" and args.judge:
        raise ValueError(
            "DeepResearch uses its pinned upstream judge configuration; do not imply a model override"
        )
    for name in ("upstream", "predictions", "data", "output"):
        setattr(args, name, getattr(args, name).resolve())
    pin = json.loads((Path(__file__).parent / "upstreams.json").read_text())[args.suite]
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=args.upstream, text=True
    ).strip()
    dirty = subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=args.upstream,
        text=True,
    )
    if commit != pin["commit"] or dirty:
        raise ValueError("Use an unmodified checkout at the commit in upstreams.json")
    args.output.mkdir(parents=True, exist_ok=False)
    write_json(
        args.output / "manifest.json",
        {
            "suite": args.suite,
            "upstream": pin,
            "judge": args.judge or "upstream configuration",
            "judge_profile": judge_profile,
            "judge_profile_sha256": digest(args.provider_profile.read_bytes())
            if args.provider_profile
            else None,
            # judge.mjs builds the provider the profile names: Responses, Codex or Chat Completions.
            "judge_transport_notes": f"Arden {judge_profile.get('provider', 'responses')} transport; empty system instructions; profile reasoning; no temperature override"
            if judge_profile
            else None,
            "judge_environment": {
                key: os.environ[key]
                for key in ("LLM_BACKEND", "RACE_MODEL", "FACT_MODEL")
                if key in os.environ
            },
            "prediction_sha256": digest(args.predictions.read_bytes()),
            "dataset_sha256": digest(args.data.read_bytes()),
        },
    )
    shutil.copyfile(args.predictions, args.output / "predictions.jsonl")
    if args.suite == "browsecomp":
        grade_browse(args, args.output)
    else:
        plan = commands(args, args.output)
        write_json(args.output / "commands.json", plan)
        for index, command in enumerate(plan):
            with (args.output / f"step-{index}.log").open("w") as log:
                subprocess.run(
                    command,
                    cwd=args.upstream,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    check=True,
                )
    print(args.output)


if __name__ == "__main__":
    main()
